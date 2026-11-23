//go:build darwin

package ports

import (
	"errors"
	"os/exec"
	"strconv"
	"strings"
)

func Find(roots []int) ([]Port, error) {
	out, err := exec.Command("/bin/ps", "-A", "-o", "pid=,ppid=,comm=").Output()
	if err != nil {
		return nil, err
	}
	table := parsePS(out)
	owner := under(table, roots)
	if onlyShells(owner) {
		return nil, nil
	}
	pids := make([]string, 0, len(owner))
	for pid := range owner {
		pids = append(pids, strconv.Itoa(pid))
	}
	out, err = exec.Command("/usr/sbin/lsof", "-nP", "-a", "-p", strings.Join(pids, ","),
		"-iTCP", "-sTCP:LISTEN", "-Fpn").Output()
	var exit *exec.ExitError
	if err != nil && !(errors.As(err, &exit) && exit.ExitCode() == 1) {
		return nil, err
	}
	return match(parseLsof(out), table, owner), nil
}
