// Package fs implements the workspace-bound filesystem RPC methods exposed by
// the agent binary.
//
// Workspace paths are resolved through Service.Resolve, which is the single
// trust boundary preventing escapes via `..` or absolute paths. The explicit
// fs.readAbsolute method is the read-only exception used for LSP/external
// references that are already absolute on the same machine as the agent.
// Symlinks are inspected with Lstat so a symlink pointing outside the workspace
// is reported as a symlink, not followed, matching the conservative semantics
// of the legacy TS handlers.
package fs

import (
	"path/filepath"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
)

// MaxReadableFileSize caps how many bytes one fs.readFile / fs.writeFile call
// may move. The threshold matches the renderer's editor capacity so we never
// produce a file that we couldn't reload.
const MaxReadableFileSize = 5 * 1024 * 1024

// EventSink is the callback fs uses to push agent events back to Electron.
type EventSink func(event string, payload any) error

// Service is the workspace-bound filesystem handle. One is created per agent
// process; root is fixed at startup and Resolve refuses anything escaping it.
type Service struct {
	root string

	mu      sync.Mutex
	watches map[string]*watchEntry
	buffers map[string]FsChangeKind
	timer   *time.Timer
	sink    EventSink
}

// New constructs a Service rooted at the given absolute path. The path is
// cleaned and canonicalized once so later Resolve calls can rely on
// filepath.Rel checks.
func New(root string) (*Service, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &Service{
		root:    filepath.Clean(abs),
		watches: make(map[string]*watchEntry),
		buffers: make(map[string]FsChangeKind),
	}, nil
}

// SetEventSink wires the service to the stdio host after both are constructed.
func (s *Service) SetEventSink(sink EventSink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sink = sink
}

// Close stops watcher goroutines and clears buffered fs events.
func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	for abs, entry := range s.watches {
		entry.close()
		delete(s.watches, abs)
	}
	clear(s.buffers)
}

// Register binds every fs.* method this package implements onto the dispatcher.
func Register(d *dispatch.Dispatcher, fsys *Service) {
	d.Register("fs.readdir", fsys.Readdir)
	d.Register("fs.stat", fsys.Stat)
	d.Register("fs.readFile", fsys.ReadFile)
	d.Register("fs.readBinary", fsys.ReadBinary)
	d.Register("fs.readAbsolute", fsys.ReadAbsolute)
	d.Register("fs.writeFile", fsys.WriteFile)
	d.Register("fs.createFile", fsys.CreateFile)
	d.Register("fs.mkdir", fsys.Mkdir)
	d.Register("fs.unlink", fsys.Unlink)
	d.Register("fs.rmdir", fsys.Rmdir)
	d.Register("fs.rename", fsys.Rename)
	d.Register("fs.copyFile", fsys.CopyFile)
	d.Register("fs.removeAll", fsys.RemoveAll)
	d.Register("fs.watch", fsys.Watch)
	d.Register("fs.unwatch", fsys.Unwatch)
}
