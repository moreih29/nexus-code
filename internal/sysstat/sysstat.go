// Package sysstat tells how busy the agent's host is: the share of its CPU
// in use and how much of its memory, for the status bar of a workspace on
// that host. The app reads its own machine itself; an SSH or WSL workspace
// asks its agent, so the numbers are the host's the workspace runs on.
package sysstat

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
)

// Stats is the wire shape system.stats returns.
type Stats struct {
	// CPU is the share of the host's CPU time in use, 0 to 100, over the
	// time since the last ask; nil when it cannot be told.
	CPU *float64 `json:"cpu"`
	// MemUsed and MemTotal are bytes: the memory programs hold, as the
	// host's own monitor counts it, and all there is.
	MemUsed  uint64 `json:"memUsed"`
	MemTotal uint64 `json:"memTotal"`
}

// cpuTimes is the host's CPU time so far, summed over its CPUs: all of it,
// and the part spent idle.
type cpuTimes struct {
	total uint64
	idle  uint64
}

// busy is the share of the time between two readings spent not idle; ok is
// false when no time passed between them.
func busy(prev, next cpuTimes) (float64, bool) {
	if next.total <= prev.total || next.idle < prev.idle {
		return 0, false
	}
	total := float64(next.total - prev.total)
	idle := float64(next.idle - prev.idle)
	share := 100 * (total - idle) / total
	if share < 0 {
		share = 0
	}
	if share > 100 {
		share = 100
	}
	return share, true
}

const (
	// staleAfter is how old a reading may be and still start the next span:
	// an older one would give an average over minutes, so a new span starts.
	staleAfter = 10 * time.Second
	// firstSpan is how long a new span runs before its first answer.
	firstSpan = 250 * time.Millisecond
)

// Service keeps the last CPU reading, so each ask is answered for the span
// since the one before.
type Service struct {
	mu      sync.Mutex
	last    cpuTimes
	lastAt  time.Time
	lastCPU *float64

	// direct, readCPU, readMemory, sleep and now are the host's, swapped in
	// tests. direct answers the share at once where the host has no running
	// totals to read (ok false where it does).
	direct     func() (share *float64, ok bool)
	readCPU    func() (cpuTimes, error)
	readMemory func() (used, total uint64, err error)
	sleep      func(time.Duration)
	now        func() time.Time
}

// New makes a Service that reads this host.
func New() *Service {
	return &Service{
		direct:     directCPU,
		readCPU:    readCPU,
		readMemory: readMemory,
		sleep:      time.Sleep,
		now:        time.Now,
	}
}

// Register binds system.stats onto the dispatcher.
func Register(d *dispatch.Dispatcher, service *Service) {
	d.Register("system.stats", service.Stats)
}

// Stats answers system.stats. A host whose CPU cannot be read still tells
// its memory, and the other way round; one that tells neither fails.
func (s *Service) Stats(_ context.Context, _ json.RawMessage) (any, error) {
	cpu, cpuErr := s.cpu()
	used, total, memErr := s.readMemory()
	if cpuErr != nil && memErr != nil {
		return nil, memErr
	}
	return Stats{CPU: cpu, MemUsed: used, MemTotal: total}, nil
}

func (s *Service) cpu() (*float64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if direct, ok := s.direct(); ok {
		return direct, nil
	}
	if s.lastAt.IsZero() || s.now().Sub(s.lastAt) > staleAfter {
		first, err := s.readCPU()
		if err != nil {
			return nil, err
		}
		s.last, s.lastAt = first, s.now()
		s.sleep(firstSpan)
	}
	next, err := s.readCPU()
	if err != nil {
		return nil, err
	}
	share, ok := busy(s.last, next)
	if !ok {
		// Asked again before any time passed: the last answer stands.
		return s.lastCPU, nil
	}
	s.last, s.lastAt, s.lastCPU = next, s.now(), &share
	return &share, nil
}
