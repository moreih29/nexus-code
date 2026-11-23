//go:build darwin

package lsp

import "os/exec"

func processTable() (map[int]processEntry, error) {
	out, err := exec.Command("/bin/ps", "-A", "-o", "pid=,ppid=,rss=").Output()
	if err != nil {
		return nil, err
	}
	return parsePSOutput(out), nil
}
