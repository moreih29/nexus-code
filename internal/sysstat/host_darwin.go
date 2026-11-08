//go:build darwin

package sysstat

import (
	"errors"
	"os/exec"
	"runtime"

	"golang.org/x/sys/unix"
)

// readCPU is not used on macOS: the CPU's ticks are read through Mach,
// which needs cgo, and the agent is built without it. directCPU asks ps.
func readCPU() (cpuTimes, error) {
	return cpuTimes{}, errors.New("not read on macOS")
}

// directCPU sums the processes' %cpu. ps gives each a decaying average over
// the last minute or so, so the share follows a change in a few seconds
// rather than at once; about 30 ms a look.
func directCPU() (*float64, bool) {
	out, err := exec.Command("/bin/ps", "-A", "-o", "%cpu=").Output()
	if err != nil {
		return nil, true
	}
	share, ok := parsePSCPU(out, runtime.NumCPU())
	if !ok {
		return nil, true
	}
	return &share, true
}

func readMemory() (uint64, uint64, error) {
	total, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return 0, 0, err
	}
	out, err := exec.Command("/usr/bin/vm_stat").Output()
	if err != nil {
		return 0, 0, err
	}
	used, ok := parseVMStat(out)
	if !ok {
		return 0, 0, errors.New("vm_stat gave no page counts")
	}
	if used > total {
		used = total
	}
	return used, total, nil
}
