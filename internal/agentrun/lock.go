package agentrun

import (
	"errors"
	"fmt"
	"os"
)

type Lock struct {
	file *os.File
}

var ErrLockHeld = errors.New("agentrun: workspace lock held by another process — daemon already running")

func TryLock(path string) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("agentrun: open lock file %q: %w", path, err)
	}

	if err := lockFile(f); err != nil {
		f.Close()
		if errors.Is(err, errLockBusy) {
			return nil, ErrLockHeld
		}
		if errors.Is(err, errLockUnsupported) {
			return tryLockPIDFallback(path)
		}
		return nil, fmt.Errorf("agentrun: lock %q: %w", path, err)
	}

	return &Lock{file: f}, nil
}

func (l *Lock) Unlock() {
	if l == nil || l.file == nil {
		return
	}
	_ = l.file.Close()
	l.file = nil
}

func tryLockPIDFallback(path string) (*Lock, error) {
	data, readErr := os.ReadFile(path)
	if readErr == nil && len(data) > 0 {
		var pid int
		if _, err := fmt.Sscanf(string(data), "%d", &pid); err == nil && pid > 0 {
			if processAlive(pid) {
				return nil, ErrLockHeld
			}
		}
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0600)
	if err != nil {
		return nil, fmt.Errorf("agentrun: pid-fallback open %q: %w", path, err)
	}
	if _, err := fmt.Fprintf(f, "%d\n", os.Getpid()); err != nil {
		f.Close()
		return nil, fmt.Errorf("agentrun: pid-fallback write %q: %w", path, err)
	}
	return &Lock{file: f}, nil
}
