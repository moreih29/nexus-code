package sysstat

import (
	"bufio"
	"bytes"
	"regexp"
	"strconv"
	"strings"
)

func parseProcStat(data []byte) (cpuTimes, bool) {
	line, _, _ := bytes.Cut(data, []byte("\n"))
	fields := strings.Fields(string(line))
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuTimes{}, false
	}
	var times cpuTimes
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
