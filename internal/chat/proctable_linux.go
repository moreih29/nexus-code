//go:build linux

package chat

import (
	"bytes"
	"os"
	"strconv"

	hostproc "github.com/nexus-code/nexus-code/internal/process"
)

func parents() map[int]int {
	dirs, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	table := make(map[int]int, len(dirs))
	for _, dir := range dirs {
		pid, err := strconv.Atoi(dir.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile("/proc/" + dir.Name() + "/stat")
		if err != nil {
			continue
		}
		if ppid, ok := parentInStat(data); ok {
			table[pid] = ppid
		}
	}
	return table
}

func parentInStat(data []byte) (int, bool) {
	_, suffix := hostproc.SplitPIDStat(data)
	fields := bytes.Fields(suffix)
	if len(fields) < 2 {
		return 0, false
	}
	ppid, err := strconv.Atoi(string(fields[1]))
	return ppid, err == nil
}

func processStart(pid int) uint64 {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0
	}
	_, suffix := hostproc.SplitPIDStat(data)
	fields := bytes.Fields(suffix)
	const startTimeField = 22 - 3
	if len(fields) <= startTimeField {
		return 0
	}
	start, _ := strconv.ParseUint(string(fields[startTimeField]), 10, 64)
	return start
}
