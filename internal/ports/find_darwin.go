//go:build darwin

package ports

import (
	"errors"
	"os/exec"
	"strconv"
	"strings"
)

// Find lists the ports the processes under roots listen on. Reading another
// process's sockets takes libproc, which needs cgo, and the agent is built
// without it: ps gives the process tree and lsof the sockets of the
// processes in it, about 30 ms each.
func Find(roots []int) ([]Port, error) {
	out, err := exec.Command("/bin/ps", "-A", "-o", "pid=,ppid=,comm=").Output()
	if err != nil {
		return nil, err
	}
	table := parsePS(out)
	owner := under(table, roots)
	if len(owner) == 0 {
		return nil, nil
	}
	pids := make([]string, 0, len(owner))
	for pid := range owner {
		pids = append(pids, strconv.Itoa(pid))
	}
	// -a ands the selections: these processes' TCP sockets in LISTEN. lsof
	// exits 1 when it finds none, or when one of the processes has exited
	// since ps listed it, after printing what it found of the rest.
	out, err = exec.Command("/usr/sbin/lsof", "-nP", "-a", "-p", strings.Join(pids, ","),
		"-iTCP", "-sTCP:LISTEN", "-Fpn").Output()
	var exit *exec.ExitError
	if err != nil && !(errors.As(err, &exit) && exit.ExitCode() == 1) {
		return nil, err
	}
	return match(parseLsof(out), table, owner), nil
}
