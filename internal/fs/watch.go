package fs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const watchDebounce = 300 * time.Millisecond

type watchEntry struct {
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

// Watch starts a depth-0 watcher for one workspace-relative directory.
func (s *Service) Watch(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.parseWatchPath(raw)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	if !info.IsDir() {
		return nil, FSError{Code: CodeIsDirectory, Path: abs}
	}

	s.mu.Lock()
	if _, exists := s.watches[abs]; exists {
		s.mu.Unlock()
		return struct{}{}, nil
	}
	s.mu.Unlock()

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	if err := watcher.Add(abs); err != nil {
		_ = watcher.Close()
		return nil, mapPathError(err, abs)
	}

	entry := &watchEntry{watcher: watcher, done: make(chan struct{})}

	s.mu.Lock()
	if _, exists := s.watches[abs]; exists {
		s.mu.Unlock()
		entry.close()
		return struct{}{}, nil
	}
	s.watches[abs] = entry
	s.mu.Unlock()

	go s.runWatch(abs, entry)
	return struct{}{}, nil
}

// Unwatch stops a previously registered directory watcher.
func (s *Service) Unwatch(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.parseWatchPath(raw)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	s.mu.Lock()
	entry := s.watches[abs]
	if entry != nil {
		delete(s.watches, abs)
	}
	s.mu.Unlock()

	if entry != nil {
		entry.close()
	}
	return struct{}{}, nil
}

func (s *Service) parseWatchPath(raw json.RawMessage) (string, error) {
	var p WatchParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return "", proto.ProtocolError("fs.watch params must include relPath")
	}
	return s.Resolve(p.RelPath)
}

func (s *Service) runWatch(absDir string, entry *watchEntry) {
	for {
		select {
		case event, ok := <-entry.watcher.Events:
			if !ok {
				s.removeWatch(absDir, entry)
				return
			}
			s.handleWatchEvent(event)
		case _, ok := <-entry.watcher.Errors:
			if !ok {
				s.removeWatch(absDir, entry)
				return
			}
		case <-entry.done:
			return
		}
	}
}

func (s *Service) removeWatch(absDir string, entry *watchEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watches[absDir] == entry {
		delete(s.watches, absDir)
	}
}

func (s *Service) handleWatchEvent(event fsnotify.Event) {
	kind, ok := changeKind(event)
	if !ok {
		return
	}
	base := filepath.Base(event.Name)
	if _, hidden := hiddenNames[base]; hidden {
		return
	}
	rel, err := filepath.Rel(s.root, event.Name)
	if err != nil || rel == "." || rel == "" || filepath.IsAbs(rel) || rel == ".." || hasDotDotPrefix(rel) {
		return
	}
	s.bufferChange(filepath.ToSlash(rel), kind)
}

func changeKind(event fsnotify.Event) (FsChangeKind, bool) {
	switch {
	case event.Op&(fsnotify.Remove|fsnotify.Rename) != 0:
		return FsChangeDeleted, true
	case event.Op&fsnotify.Create != 0:
		return FsChangeAdded, true
	case event.Op&fsnotify.Write != 0:
		return FsChangeModified, true
	default:
		return "", false
	}
}

func (s *Service) bufferChange(relPath string, kind FsChangeKind) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.buffers[relPath] = kind
	if s.timer != nil {
		return
	}
	s.timer = time.AfterFunc(watchDebounce, s.flushChanges)
}

func (s *Service) flushChanges() {
	s.mu.Lock()
	s.timer = nil
	if len(s.buffers) == 0 {
		s.mu.Unlock()
		return
	}
	changes := make([]FsChange, 0, len(s.buffers))
	for relPath, kind := range s.buffers {
		changes = append(changes, FsChange{RelPath: relPath, Kind: kind})
	}
	clear(s.buffers)
	sink := s.sink
	s.mu.Unlock()

	if sink != nil {
		_ = sink("fs.changed", FsChangedPayload{Changes: changes})
	}
}

func hasDotDotPrefix(rel string) bool {
	return rel == ".." || len(rel) > 3 && rel[:3] == ".."+string(filepath.Separator)
}
