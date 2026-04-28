package git

import (
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"nexus-code/sidecar/internal/contracts"
)

type WatcherFactory func(WatcherOptions) (WatchHandle, error)

type WatcherOptions struct {
	WorkspaceID contracts.WorkspaceID
	WatchID     string
	Cwd         string
	Debounce    time.Duration
	OnChange    func()
}

type WatchHandle interface {
	Close() error
	WatchedPaths() []string
}

type FSNotifyWatcher struct {
	watcher   *fsnotify.Watcher
	debouncer *debouncer
	done      chan struct{}
	closed    chan struct{}
	closeOnce sync.Once

	mu      sync.Mutex
	watched map[string]struct{}
}

func NewFSNotifyWatcher(options WatcherOptions) (WatchHandle, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	debounce := options.Debounce
	if debounce <= 0 {
		debounce = defaultDebounce
	}
	onChange := options.OnChange
	if onChange == nil {
		onChange = func() {}
	}
	handle := &FSNotifyWatcher{
		watcher:   watcher,
		debouncer: newDebouncer(debounce, onChange),
		done:      make(chan struct{}),
		closed:    make(chan struct{}),
		watched:   map[string]struct{}{},
	}
	go handle.run()
	if err := handle.addRecursive(options.Cwd); err != nil {
		_ = handle.Close()
		return nil, err
	}
	return handle, nil
}

func (w *FSNotifyWatcher) Close() error {
	var err error
	w.closeOnce.Do(func() {
		close(w.done)
		w.debouncer.Close()
		err = w.watcher.Close()
		<-w.closed
	})
	return err
}

func (w *FSNotifyWatcher) WatchedPaths() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	paths := make([]string, 0, len(w.watched))
	for path := range w.watched {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func (w *FSNotifyWatcher) run() {
	defer close(w.closed)
	for {
		select {
		case <-w.done:
			return
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			w.handleEvent(event)
		case _, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
		}
	}
}

func (w *FSNotifyWatcher) handleEvent(event fsnotify.Event) {
	if event.Op&fsnotify.Create != 0 {
		if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
			_ = w.addRecursive(event.Name)
		}
	}
	if event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Remove|fsnotify.Rename|fsnotify.Chmod) != 0 {
		w.debouncer.Trigger()
	}
}

func (w *FSNotifyWatcher) addRecursive(root string) error {
	return filepath.WalkDir(root, func(path string, dirEntry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !dirEntry.IsDir() {
			return nil
		}
		return w.add(path)
	})
}

func (w *FSNotifyWatcher) add(path string) error {
	cleanPath, err := filepath.Abs(path)
	if err != nil {
		return err
	}

	w.mu.Lock()
	if _, exists := w.watched[cleanPath]; exists {
		w.mu.Unlock()
		return nil
	}
	w.mu.Unlock()

	if err := w.watcher.Add(cleanPath); err != nil {
		return err
	}

	w.mu.Lock()
	w.watched[cleanPath] = struct{}{}
	w.mu.Unlock()
	return nil
}

type debouncer struct {
	duration time.Duration
	fn       func()

	mu     sync.Mutex
	timer  *time.Timer
	closed bool
}

func newDebouncer(duration time.Duration, fn func()) *debouncer {
	if fn == nil {
		fn = func() {}
	}
	return &debouncer{
		duration: duration,
		fn:       fn,
	}
}

func (d *debouncer) Trigger() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return
	}
	if d.duration <= 0 {
		go d.fn()
		return
	}
	if d.timer != nil {
		d.timer.Stop()
	}
	d.timer = time.AfterFunc(d.duration, d.fn)
}

func (d *debouncer) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.closed = true
	if d.timer != nil {
		d.timer.Stop()
	}
}
