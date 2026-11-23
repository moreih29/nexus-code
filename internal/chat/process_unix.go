//go:build darwin || linux

package chat

import (
	"os"
	"sync"
	"syscall"

	hostproc "github.com/nexus-code/nexus-code/internal/process"
	"golang.org/x/sys/unix"
)

type tree struct {
	mu       sync.Mutex
	start    uint64
	targets  map[int]uint64
	released bool
}

func (p *process) holdTree() error {
	p.tree.mu.Lock()
	defer p.tree.mu.Unlock()
	p.tree.start = processStart(p.cmd.Process.Pid)
	noteOwned(p.cmd.Process.Pid, p.tree.start)
	return nil
}

func (p *process) releaseTree() {
	p.tree.mu.Lock()
	defer p.tree.mu.Unlock()
	if p.tree.targets != nil {
		_ = p.signalOwnedTargets(syscall.SIGKILL, false)
		p.tree.targets = nil
	}
	p.tree.released = true
	forgetOwned(p.cmd.Process.Pid)
}

func (p *process) signalTerm() error {
	return p.signalOwnedTree(syscall.SIGTERM)
}

func (p *process) signalKill() error {
	return p.signalOwnedTree(syscall.SIGKILL)
}

func (p *process) signalOwnedTree(signal syscall.Signal) error {
	p.tree.mu.Lock()
	defer p.tree.mu.Unlock()
	if p.tree.released {
		return os.ErrProcessDone
	}
	pid := p.cmd.Process.Pid
	start := processStart(pid)
	if p.tree.start == 0 {
		p.tree.start = start
	}
	leaderAlive := start != 0 && start == p.tree.start
	if p.tree.targets == nil {
		p.tree.targets = make(map[int]uint64)
	}
	if leaderAlive {
		for _, child := range descendants(pid) {
			if start := processStart(child); start != 0 {
				p.tree.targets[child] = start
			}
		}
	}
	err := p.signalOwnedTargets(signal, leaderAlive)
	if !leaderAlive && start == 0 && p.tree.start == 0 {
		return p.cmd.Process.Signal(signal)
	}
	return err
}

func (p *process) signalOwnedTargets(signal syscall.Signal, leaderAlive bool) error {
	pid := p.cmd.Process.Pid
	groupAlive := leaderAlive
	targets := make([]int, 0, len(p.tree.targets))
	for child, start := range p.tree.targets {
		if processStart(child) == start {
			targets = append(targets, child)
			if pgid, err := unix.Getpgid(child); err == nil && pgid == pid {
				groupAlive = true
			}
		}
	}
	var err error
	if groupAlive {
		err = hostproc.SignalGroup(pid, signal)
	}
	for _, child := range targets {
		_ = syscall.Kill(child, signal)
	}
	return err
}

func descendants(pid int) []int {
	children := map[int][]int{}
	for child, parent := range parents() {
		if child != parent {
			children[parent] = append(children[parent], child)
		}
	}
	var found []int
	seen := map[int]bool{pid: true}
	stack := append([]int(nil), children[pid]...)
	for len(stack) > 0 {
		child := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[child] {
			continue
		}
		seen[child] = true
		found = append(found, child)
		stack = append(stack, children[child]...)
	}
	return found
}

func sameEnvKey(a, b string) bool {
	return a == b
}
