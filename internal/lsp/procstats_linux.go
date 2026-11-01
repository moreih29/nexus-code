//go:build linux

package lsp

import (
	"os"
	"strconv"
)

func processTable() (map[int]processEntry, error) {
	dirs, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	pageSize := uint64(os.Getpagesize())
	table := make(map[int]processEntry, len(dirs))
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
		if entry, ok := parseProcStat(data, pageSize); ok {
			table[pid] = entry
		}
	}
	return table, nil
}
