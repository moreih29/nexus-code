package sysstat

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
)

type Stats struct {
	CPU      *float64 `json:"cpu"`
	MemUsed  uint64   `json:"memUsed"`
	MemTotal uint64   `json:"memTotal"`
}

type cpuTimes struct {
	total uint64
	idle  uint64
}

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
	staleAfter = 10 * time.Second
	firstSpan  = 250 * time.Millisecond
)

type Service struct {
	mu      sync.Mutex
	last    cpuTimes
	lastAt  time.Time
	lastCPU *float64

	direct     func() (share *float64, ok bool)
	readCPU    func() (cpuTimes, error)
	readMemory func() (used, total uint64, err error)
	sleep      func(time.Duration)
	now        func() time.Time
}

func New() *Service {
	return &Service{
		direct:     directCPU,
		readCPU:    readCPU,
		readMemory: readMemory,
		sleep:      time.Sleep,
		now:        time.Now,
	}
}

func Register(d *dispatch.Dispatcher, service *Service) {
	d.Register("system.stats", service.Stats)
}

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
		return s.lastCPU, nil
	}
	s.last, s.lastAt, s.lastCPU = next, s.now(), &share
	return &share, nil
}
