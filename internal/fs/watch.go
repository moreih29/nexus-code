package fs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/nexus-code/nexus-code/internal/filewatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const watchDebounce = 300 * time.Millisecond

const shareWatcher = runtime.GOOS == "linux"

type watchEntry struct {
	watcher *fsnotify.Watcher
	shared  bool
	dirs    map[string]struct{}
	done    chan struct{}
	once    sync.Once
}

func (e *watchEntry) close() {
	e.once.Do(func() {
		_ = e.watcher.Close()
		close(e.done)
	})
}

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
	symlink := info.Mode()&os.ModeSymlink != 0
	if symlink {
		if info, err = os.Stat(abs); err != nil {
			return nil, mapPathError(err, abs)
		}
	}
	if !info.IsDir() {
		return nil, FSError{Code: CodeNotDirectory, Path: abs}
	}

	s.watchMu.Lock()
	defer s.watchMu.Unlock()

	s.mu.Lock()
	if _, exists := s.watches[abs]; exists {
		s.mu.Unlock()
		return struct{}{}, nil
	}
	s.mu.Unlock()

	entry := s.shared
	if entry == nil || symlink {
		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			return nil, err
		}
		entry = &watchEntry{
			watcher: watcher,
			shared:  shareWatcher && !symlink,
			dirs:    make(map[string]struct{}),
			done:    make(chan struct{}),
		}
		if entry.shared {
			s.shared = entry
		}
		go s.runWatch(entry)
	}

	s.mu.Lock()
	entry.dirs[abs] = struct{}{}
	s.watches[abs] = entry
	s.mu.Unlock()

	if err := entry.watcher.Add(abs); err != nil {
		s.mu.Lock()
		s.forgetLocked(entry, abs)
		s.mu.Unlock()
		if !entry.shared {
			entry.close()
		}
		return nil, mapPathError(err, abs)
	}
	return struct{}{}, nil
}

func (s *Service) Unwatch(ctx context.Context, raw json.RawMessage) (any, error) {
	abs, err := s.parseWatchPath(raw)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	s.watchMu.Lock()
	defer s.watchMu.Unlock()

	s.mu.Lock()
	entry := s.watches[abs]
	if entry != nil {
		s.forgetLocked(entry, abs)
	}
	s.mu.Unlock()

	if entry != nil {
		if entry.shared {
			_ = entry.watcher.Remove(abs)
		} else {
			entry.close()
		}
	}
	return struct{}{}, nil
}

func (s *Service) watchOrderKey(raw json.RawMessage) string {
	path, _ := s.parseWatchPath(raw)
	return "fs.watch:" + path
}

func (s *Service) parseWatchPath(raw json.RawMessage) (string, error) {
	var p WatchParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return "", proto.ProtocolError("fs.watch params must include relPath")
	}
	return s.Resolve(p.RelPath)
}

func (s *Service) runWatch(entry *watchEntry) {
	for {
		select {
		case event, ok := <-entry.watcher.Events:
			if !ok {
				s.removeWatches(entry)
				return
			}
			if !s.watching(entry, event.Name) {
				continue
			}
			s.handleWatchEvent(event)
			if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 && s.forgetRemovedDir(entry, event.Name) {
				entry.close()
				return
			}
		case _, ok := <-entry.watcher.Errors:
			if !ok {
				s.removeWatches(entry)
				return
			}
		case <-entry.done:
			return
		}
	}
}

func (s *Service) watching(entry *watchEntry, name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, self := entry.dirs[name]
	_, parent := entry.dirs[filepath.Dir(name)]
	return self || parent
}

func (s *Service) forgetRemovedDir(entry *watchEntry, absDir string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := entry.dirs[absDir]; !ok {
		return false
	}
	s.forgetLocked(entry, absDir)
	return !entry.shared && len(entry.dirs) == 0
}

func (s *Service) removeWatches(entry *watchEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for absDir := range entry.dirs {
		s.forgetLocked(entry, absDir)
	}
}

func (s *Service) forgetLocked(entry *watchEntry, absDir string) {
	delete(entry.dirs, absDir)
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

func changeKind(event fsnotify.Event) (filewatch.FsChangeKind, bool) {
	switch {
	case event.Op&(fsnotify.Remove|fsnotify.Rename) != 0:
		return filewatch.FsChangeDeleted, true
	case event.Op&fsnotify.Create != 0:
		return filewatch.FsChangeAdded, true
	case event.Op&fsnotify.Write != 0:
		return filewatch.FsChangeModified, true
	default:
		return "", false
	}
}

func (s *Service) bufferChange(relPath string, kind filewatch.FsChangeKind) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if kind != filewatch.FsChangeModified || s.buffers[relPath] != filewatch.FsChangeAdded {
		s.buffers[relPath] = kind
	}
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
	changes := make([]filewatch.FsChange, 0, len(s.buffers))
	for relPath, kind := range s.buffers {
		changes = append(changes, filewatch.FsChange{RelPath: relPath, Kind: kind})
	}
	clear(s.buffers)
	sink := s.sink
	s.mu.Unlock()

	if sink != nil {
		_ = sink("fs.changed", filewatch.FsChangedPayload{Changes: changes})
	}
}
