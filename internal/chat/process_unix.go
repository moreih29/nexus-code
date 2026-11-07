//go:build darwin || linux

package chat

import (
	"errors"
	"os"
	"syscall"
)

// tree is nothing of its own on Unix: the program's process group and its
// descendants, found when it is signalled, are the commands it runs.
type tree struct{}

func (p *process) holdTree()    {}
func (p *process) releaseTree() {}

// signalTerm asks the program and the commands it runs to exit.
func (p *process) signalTerm() error {
	return signalTree(p.cmd.Process.Pid, syscall.SIGTERM)
}

// kill kills the program and the commands it runs.
func (p *process) kill() {
	_ = signalTree(p.cmd.Process.Pid, syscall.SIGKILL)
}

// signalTree signals the program's process group, and every process under
// the program: Claude and Codex start each command in a session of its
// own, out of the group. Ending the program alone left them running, as a
// server Claude started was once the agent exited. Its descendants are
// found first, while the program runs: once it has exited, they are
// another process's children. A command left running when the program
// exits by itself is not found.
func signalTree(pid int, signal syscall.Signal) error {
	under := descendants(pid)
	err := signalGroup(pid, signal)
	for _, child := range under {
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

func signalGroup(pid int, signal syscall.Signal) error {
	err := syscall.Kill(-pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
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
