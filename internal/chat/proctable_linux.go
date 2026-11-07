//go:build linux

package chat

import (
	"bytes"
	"os"
	"strconv"
)

// parents maps each process to its parent, read from /proc.
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
		// A process can exit between the listing and this read.
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

// parentInStat reads the parent from the contents of /proc/<pid>/stat. The
// command name, field 2, is in parentheses and may hold spaces and
// parentheses itself, so fields are counted from the last ")": the state,
// then the parent.
func parentInStat(data []byte) (int, bool) {
	end := bytes.LastIndexByte(data, ')')
	if end < 0 {
		return 0, false
	}
	fields := bytes.Fields(data[end+1:])
	if len(fields) < 2 {
		return 0, false
	}
	ppid, err := strconv.Atoi(string(fields[1]))
	return ppid, err == nil
}
