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
	"github.com/nexus-code/nexus-code/internal/proto"
)

const watchDebounce = 300 * time.Millisecond

// shareWatcher puts every watched directory on one fsnotify.Watcher.
//
// On Linux each Watcher is an inotify instance, and the per-user instance
// limit (fs.inotify.max_user_instances, 128 by default and shared with every
// other process of the same user) made fs.watch fail with "too many open
// files" after about a hundred directories. kqueue has no such limit, and a
// shared kqueue watcher would report less: it watches a directory's entries
// through the same descriptors it uses for watched subdirectories, so
// unwatching a collapsed subdirectory would also stop the still-watched
// parent from seeing that subdirectory deleted.
const shareWatcher = runtime.GOOS == "linux"

// watchEntry is one fsnotify.Watcher and the directories added to it: every
// watched directory except symlinked ones when shared is set, otherwise
// exactly one.
type watchEntry struct {
	watcher *fsnotify.Watcher
	shared  bool
	dirs    map[string]struct{} // guarded by Service.mu
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
	// A symlinked directory (the workspace root may be one) is watched
	// through the link, on a watcher of its own: inotify watches by inode,
	// and fsnotify keeps one path per inode, so on the shared watcher the
	// link and a watched target would report under only one of the paths.
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

	// Registered before Add so the event loop does not filter out the
	// directory's first events.
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

// Unwatch stops a previously registered directory watcher.
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
			// A shared watcher can still deliver events queued before a
			// directory was unwatched.
			if !s.watching(entry, event.Name) {
				continue
			}
			s.handleWatchEvent(event)
			// A watched directory itself was removed or renamed away.
			// fsnotify drops the OS watch but keeps the channels open, so
			// without this the stale entry would turn the next Watch of a
			// directory recreated at the same path into a silent no-op
			// (Watch returns early when the path is present).
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

// watching reports whether name is one of entry's directories or a direct
// child of one.
func (s *Service) watching(entry *watchEntry, name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, self := entry.dirs[name]
	_, parent := entry.dirs[filepath.Dir(name)]
	return self || parent
}

// forgetRemovedDir drops absDir if it is one of entry's directories and
// reports whether entry is left with nothing to watch and should be closed.
// The shared watcher stays open; fsnotify removes the OS watch of a deleted
// or moved directory by itself.
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
