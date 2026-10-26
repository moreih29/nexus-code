package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const gitWatchDebounce = 300 * time.Millisecond

type WatchParams struct {
	GitDir string `json:"gitDir"`
}

type ChangedPayload struct {
	GitDir string `json:"gitDir"`
}

type watchEntry struct {
	gitDir  string
	watcher *fsnotify.Watcher
	done    chan struct{}
	once    sync.Once
}

func (e *watchEntry) close() {
	e.once.Do(func() {
		_ = e.watcher.Close()
		close(e.done)
	})
}

// Watch starts a recursive watcher for a repository's .git directory.
func (s *Service) Watch(ctx context.Context, raw json.RawMessage) (any, error) {
	gitDir, err := s.parseWatchParams(ctx, raw)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Stat(gitDir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, proto.ProtocolError("git.watch gitDir must be a directory")
	}

	s.mu.Lock()
	if _, exists := s.watches[gitDir]; exists {
		s.mu.Unlock()
		return struct{}{}, nil
	}
	s.mu.Unlock()

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	entry := &watchEntry{gitDir: gitDir, watcher: watcher, done: make(chan struct{})}
	if err := addGitWatchDirs(watcher, gitDir, gitDir); err != nil {
		entry.close()
		return nil, err
	}

	s.mu.Lock()
	if _, exists := s.watches[gitDir]; exists {
		s.mu.Unlock()
		entry.close()
		return struct{}{}, nil
	}
	s.watches[gitDir] = entry
	s.mu.Unlock()

	go s.runWatch(entry)
	return struct{}{}, nil
}

// Unwatch stops a previously registered git metadata watcher.
func (s *Service) Unwatch(ctx context.Context, raw json.RawMessage) (any, error) {
	gitDir, err := s.parseWatchParams(ctx, raw)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	s.mu.Lock()
	entry := s.watches[gitDir]
	if entry != nil {
		delete(s.watches, gitDir)
	}
	s.mu.Unlock()

	if entry != nil {
		entry.close()
	}
	return struct{}{}, nil
}

func (s *Service) parseWatchParams(ctx context.Context, raw json.RawMessage) (string, error) {
	var params WatchParams
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return "", proto.ProtocolError("git.watch params must include gitDir")
	}
	return s.resolveGitDir(ctx, params.GitDir)
}

func (s *Service) runWatch(entry *watchEntry) {
	for {
		select {
		case event, ok := <-entry.watcher.Events:
			if !ok {
				s.removeWatch(entry)
				return
			}
			s.handleGitWatchEvent(entry, event)
		case _, ok := <-entry.watcher.Errors:
			if !ok {
				s.removeWatch(entry)
				return
			}
		case <-entry.done:
			return
		}
	}
}

func (s *Service) removeWatch(entry *watchEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watches[entry.gitDir] == entry {
		delete(s.watches, entry.gitDir)
	}
}

func (s *Service) handleGitWatchEvent(entry *watchEntry, event fsnotify.Event) {
	if !gitWatchEventIsDirty(entry.gitDir, event.Name) {
		return
	}
	if event.Op&fsnotify.Create != 0 {
		if info, err := os.Stat(event.Name); err == nil && info.IsDir() && !isIgnoredGitWatchPath(entry.gitDir, event.Name) {
			_ = addGitWatchDirs(entry.watcher, entry.gitDir, event.Name)
		}
	}
	s.bufferGitDirty(entry.gitDir)
}

func (s *Service) bufferGitDirty(gitDir string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gitDirty[gitDir] = struct{}{}
	if s.timer != nil {
		return
	}
	s.timer = time.AfterFunc(gitWatchDebounce, s.flushGitDirty)
}

func (s *Service) flushGitDirty() {
	s.mu.Lock()
	s.timer = nil
	if len(s.gitDirty) == 0 {
		s.mu.Unlock()
		return
	}
	dirty := make([]string, 0, len(s.gitDirty))
	for gitDir := range s.gitDirty {
		dirty = append(dirty, gitDir)
	}
	clear(s.gitDirty)
	sink := s.sink
	s.mu.Unlock()

	if sink == nil {
		return
	}
	for _, gitDir := range dirty {
		_ = sink("git.changed", ChangedPayload{GitDir: gitDir})
	}
}

// addGitWatchDirs watches root and the directories below it that
// isIgnoredGitWatchPath, judged relative to gitDir, does not skip.
func addGitWatchDirs(watcher *fsnotify.Watcher, gitDir string, root string) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if path != root && isIgnoredGitWatchPath(gitDir, path) {
			return filepath.SkipDir
		}
		return watcher.Add(path)
	})
}

func gitWatchEventIsDirty(gitDir string, candidate string) bool {
	if isIgnoredGitWatchPath(gitDir, candidate) {
		return false
	}
	return true
}

func isIgnoredGitWatchPath(gitDir string, candidate string) bool {
	base := filepath.Base(candidate)
	if strings.HasSuffix(base, ".lock") {
		return true
	}
	rel, err := filepath.Rel(gitDir, candidate)
	if err != nil || rel == "" || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return false
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	switch parts[0] {
	case "objects", "logs":
		return true
	case "lfs":
		return len(parts) > 1 && parts[1] == "objects"
	case "modules":
		// A submodule's git directory is modules/<path> (nested submodules
		// add modules/<path> below that); skip its object store and reflogs
		// as well. It is recognized by its HEAD file, which git writes before
		// creating objects, so a submodule path or branch name containing
		// "objects" or "logs" is still watched.
		last := parts[len(parts)-1]
		if len(parts) > 2 && (last == "objects" || last == "logs") {
			_, err := os.Stat(filepath.Join(filepath.Dir(candidate), "HEAD"))
			return err == nil
		}
	}
	return false
}
