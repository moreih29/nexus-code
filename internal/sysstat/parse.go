package sysstat

import (
	"bufio"
	"bytes"
	"regexp"
	"strconv"
	"strings"
)

// parseProcStat reads the first line of Linux's /proc/stat, the time all
// CPUs spent in each state. Guest time is already in user and nice, so it
// is not counted again; waiting on I/O counts as idle, as top shows it.
func parseProcStat(data []byte) (cpuTimes, bool) {
	line, _, _ := bytes.Cut(data, []byte("\n"))
	fields := strings.Fields(string(line))
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuTimes{}, false
	}
	var times cpuTimes
	// user nice system idle iowait irq softirq steal [guest guest_nice]
	for i, field := range fields[1:] {
		if i >= 8 {
			break
		}
		n, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return cpuTimes{}, false
		}
		times.total += n
		if i == 3 || i == 4 {
			times.idle += n
		}
	}
	return times, true
}

// parseMeminfo reads Linux's /proc/meminfo: in use is what is not
// available, so the cache the kernel gives back on demand counts as free,
// as free(1) shows it.
func parseMeminfo(data []byte) (used, total uint64, ok bool) {
	var available uint64
	var haveTotal, haveAvailable bool
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		key, rest, found := strings.Cut(scanner.Text(), ":")
		if !found {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		switch key {
		case "MemTotal":
			total, haveTotal = n*1024, true
		case "MemAvailable":
			available, haveAvailable = n*1024, true
		}
	}
	if !haveTotal || !haveAvailable || available > total {
		return 0, 0, false
	}
	return total - available, total, true
}

var pageSizeRE = regexp.MustCompile(`page size of (\d+) bytes`)

// parseVMStat reads macOS's vm_stat for the memory in use as Activity
// Monitor counts it: the programs' own pages less those they let go of on
// demand, the wired ones, and those the compressor holds.
func parseVMStat(data []byte) (uint64, bool) {
	size := pageSizeRE.FindSubmatch(data)
	if size == nil {
		return 0, false
	}
	pageSize, err := strconv.ParseUint(string(size[1]), 10, 64)
	if err != nil {
		return 0, false
	}
	pages := map[string]uint64{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		key, rest, found := strings.Cut(scanner.Text(), ":")
		if !found {
			continue
		}
		n, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimSpace(rest), "."), 10, 64)
		if err == nil {
			pages[strings.Trim(key, `"`)] = n
		}
	}
	anonymous, ok1 := pages["Anonymous pages"]
	wired, ok2 := pages["Pages wired down"]
	compressor, ok3 := pages["Pages occupied by compressor"]
	if !ok1 || !ok2 || !ok3 {
		return 0, false
	}
	purgeable := pages["Pages purgeable"]
	if purgeable > anonymous {
		purgeable = anonymous
	}
	return (anonymous - purgeable + wired + compressor) * pageSize, true
}

// parsePSCPU sums ps's %cpu column over the host's CPUs.
func parsePSCPU(data []byte, cpus int) (float64, bool) {
	if cpus < 1 {
		return 0, false
	}
	var sum float64
	seen := false
	for _, field := range strings.Fields(string(data)) {
		n, err := strconv.ParseFloat(strings.ReplaceAll(field, ",", "."), 64)
		if err != nil {
			continue
		}
		sum += n
		seen = true
	}
	if !seen {
		return 0, false
	}
	share := sum / float64(cpus)
	if share > 100 {
		share = 100
	}
	return share, true
}
