//go:build linux

package sysstat

import (
	"errors"
	"os"
)

func readCPU() (cpuTimes, error) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuTimes{}, err
	}
	times, ok := parseProcStat(data)
	if !ok {
		return cpuTimes{}, errors.New("/proc/stat has no cpu line")
	}
	return times, nil
}

func readMemory() (uint64, uint64, error) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	used, total, ok := parseMeminfo(data)
	if !ok {
		return 0, 0, errors.New("/proc/meminfo has no MemTotal or MemAvailable")
	}
	return used, total, nil
}

// directCPU: Linux's share is read over a span, from /proc/stat.
func directCPU() (*float64, bool) { return nil, false }
