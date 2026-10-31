//go:build darwin

package lsp

import "os/exec"

// processTable asks ps: reading another process's memory takes libproc,
// which needs cgo, and the agent is built without it.
func processTable() (map[int]processEntry, error) {
	out, err := exec.Command("/bin/ps", "-A", "-o", "pid=,ppid=,rss=").Output()
	if err != nil {
		return nil, err
	}
	return parsePSOutput(out), nil
}
