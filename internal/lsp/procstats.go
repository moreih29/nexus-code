package lsp

import (
	"bytes"
	"strconv"
	"strings"
)

// processEntry is one row of the system's process table.
type processEntry struct {
	ppid int
	// rss is the resident memory in bytes, zero when it could not be read.
	rss uint64
}

// treeRSS sums the resident memory of each root and all its descendants.
// A language server runs much of its work in children: tsserver under
// typescript-language-server, for one.
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

// parseProcStat reads the parent and the resident pages from the contents
// of /proc/<pid>/stat. The command name, field 2, is in parentheses and may
// hold spaces and parentheses itself, so fields are counted from the last
// ")": field 3 (state) comes first, then field 4 (ppid), and field 24 (rss)
// is the 22nd.
func parseProcStat(data []byte, pageSize uint64) (processEntry, bool) {
	end := bytes.LastIndexByte(data, ')')
	if end < 0 {
		return processEntry{}, false
	}
	fields := strings.Fields(string(data[end+1:]))
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

// parsePSOutput reads `ps -A -o pid=,ppid=,rss=`, whose rss is in KiB.
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
