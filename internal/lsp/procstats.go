package lsp

import (
	"strconv"
	"strings"

	hostproc "github.com/nexus-code/nexus-code/internal/process"
)

type processEntry struct {
	ppid int
	rss  uint64
}

func treeRSS(table map[int]processEntry, roots []int) map[int]uint64 {
	children := make(map[int][]int, len(table))
	for pid, entry := range table {
		if pid != entry.ppid {
			children[entry.ppid] = append(children[entry.ppid], pid)
		}
	}
	totals := make(map[int]uint64, len(roots))
	for _, root := range roots {
		if _, ok := table[root]; !ok {
			continue
		}
		var total uint64
		seen := map[int]bool{}
		stack := []int{root}
		for len(stack) > 0 {
			pid := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if seen[pid] {
				continue
			}
			seen[pid] = true
			total += table[pid].rss
			stack = append(stack, children[pid]...)
		}
		totals[root] = total
	}
	return totals
}

func parseProcStat(data []byte, pageSize uint64) (processEntry, bool) {
	_, suffix := hostproc.SplitPIDStat(data)
	fields := strings.Fields(string(suffix))
	if len(fields) < 22 {
		return processEntry{}, false
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return processEntry{}, false
	}
	pages, err := strconv.ParseUint(fields[21], 10, 64)
	if err != nil {
		return processEntry{}, false
	}
	return processEntry{ppid: ppid, rss: pages * pageSize}, true
}

func parsePSOutput(out []byte) map[int]processEntry {
	table := map[int]processEntry{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		kib, err3 := strconv.ParseUint(fields[2], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		table[pid] = processEntry{ppid: ppid, rss: kib * 1024}
	}
	return table
}
