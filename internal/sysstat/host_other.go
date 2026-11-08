//go:build !linux && !darwin

package sysstat

import "errors"

// The app reads a local machine itself, and SSH hosts are Linux or macOS.
var errUnsupported = errors.New("system stats are not read on this platform")

func readCPU() (cpuTimes, error) { return cpuTimes{}, errUnsupported }

func readMemory() (uint64, uint64, error) { return 0, 0, errUnsupported }

func directCPU() (*float64, bool) { return nil, false }
