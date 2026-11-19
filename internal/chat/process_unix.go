//go:build darwin || linux

package chat

import (
	"os"
	"sync"
	"syscall"

	hostproc "github.com/nexus-code/nexus-code/internal/process"
	"golang.org/x/sys/unix"
)

// tree records the commands seen at explicit stop so escalation can still
// reach them after the parent exits and the OS reparents its children.
type tree struct {
	mu       sync.Mutex
	start    uint64
	targets  map[int]uint64
	released bool
}

// holdTree records the launched group's leader.
func (p *process) holdTree() error {
	p.tree.mu.Lock()
	defer p.tree.mu.Unlock()
	p.tree.start = processStart(p.cmd.Process.Pid)
	return nil
}

// releaseTree completes any explicit termination before reporting exit.
func (p *process) releaseTree() {
	p.tree.mu.Lock()
	defer p.tree.mu.Unlock()
	if p.tree.targets != nil {
		_ = p.signalOwnedTargets(syscall.SIGKILL, false)
		p.tree.targets = nil
	}
	p.tree.released = true
}

// signalTerm asks the program and the commands it runs to exit.
func (p *process) signalTerm() error {
	return p.signalOwnedTree(syscall.SIGTERM)
}

// signalKill forcefully ends the program and the commands it runs.
func (p *process) signalKill() error {
	return p.signalOwnedTree(syscall.SIGKILL)
}

// signalOwnedTree discovers detached tool sessions before signalling.
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
		// The proc table may be unavailable even while the launcher runs.
		return p.cmd.Process.Signal(signal)
	}
	return err
}

// signalOwnedTargets checks start times so recorded PIDs do not identify
// unrelated jobs after the grace period and PID reuse.
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

// descendants are the processes under pid, at any depth, as the process
// table now tells them; none when it cannot be read.
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

// exitPayload translates the program's exit into the chat.exit wire shape.
func exitPayload(key tabKey, state *os.ProcessState, err error) ExitPayload {
	payload := ExitPayload{WorkspaceID: key.workspaceID, TabID: key.tabID}
	if err != nil || state == nil {
		code := -1
		payload.Code = &code
		return payload
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		signal := signalName(status.Signal())
		payload.Signal = &signal
		return payload
	}
	code := state.ExitCode()
	payload.Code = &code
	return payload
}

func signalName(signal syscall.Signal) string {
	switch signal {
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	default:
		return signal.String()
	}
}

// sameEnvKey reports whether two variable names name the same variable.
func sameEnvKey(a, b string) bool {
	return a == b
}
