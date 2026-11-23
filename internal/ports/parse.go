package ports

import (
	"encoding/binary"
	"strconv"
	"strings"

	hostproc "github.com/nexus-code/nexus-code/internal/process"
)

func baseName(name string) string {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		return name[i+1:]
	}
	return name
}

func parsePS(out []byte) map[int]Process {
	table := map[int]Process{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil {
			continue
		}
		table[pid] = Process{PPID: ppid, Name: baseName(strings.Join(fields[2:], " "))}
	}
	return table
}

func parseLsof(out []byte) []Listener {
	var listeners []Listener
	pid := 0
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(line[1:])
		case 'n':
			colon := strings.LastIndexByte(line, ':')
			if colon < 0 || pid <= 0 {
				continue
			}
			if port, err := strconv.Atoi(line[colon+1:]); err == nil {
				listeners = append(listeners, Listener{Port: port, PID: pid})
			}
		}
	}
	return listeners
}

func parseProcStat(data []byte) (Process, bool) {
	name, suffix := hostproc.SplitPIDStat(data)
	if name == nil {
		return Process{}, false
	}
	fields := strings.Fields(string(suffix))
	if len(fields) < 2 {
		return Process{}, false
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return Process{}, false
	}
	return Process{PPID: ppid, Name: string(name)}, true
}

const tcpListen = "0A"

func parseProcNetTCP(data []byte) map[uint64]int {
	ports := map[uint64]int{}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 10 || fields[3] != tcpListen {
			continue
		}
		colon := strings.LastIndexByte(fields[1], ':')
		if colon < 0 {
			continue
		}
		port, err := strconv.ParseUint(fields[1][colon+1:], 16, 16)
		if err != nil {
			continue
		}
		inode, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil || inode == 0 {
			continue
		}
		ports[inode] = int(port)
	}
	return ports
}

func socketInode(link string) (uint64, bool) {
	rest, ok := strings.CutPrefix(link, "socket:[")
	if !ok || !strings.HasSuffix(rest, "]") {
		return 0, false
	}
	inode, err := strconv.ParseUint(rest[:len(rest)-1], 10, 64)
	return inode, err == nil
}

const mibTCPStateListen = 2

func parseTCPTable(buf []byte) []Listener {
	const rowSize = 24
	return parseTable(buf, rowSize, 0, 8, 20)
}

func parseTCP6Table(buf []byte) []Listener {
	const rowSize = 56
	return parseTable(buf, rowSize, 48, 20, 52)
}

func parseTable(buf []byte, rowSize, stateAt, portAt, pidAt int) []Listener {
	if len(buf) < 4 {
		return nil
	}
	count := int(binary.LittleEndian.Uint32(buf))
	var listeners []Listener
	for i := 0; i < count; i++ {
		start := 4 + i*rowSize
		if start+rowSize > len(buf) {
			break
		}
		row := buf[start : start+rowSize]
		if binary.LittleEndian.Uint32(row[stateAt:]) != mibTCPStateListen {
			continue
		}
		port := int(row[portAt])<<8 | int(row[portAt+1])
		pid := int(binary.LittleEndian.Uint32(row[pidAt:]))
		listeners = append(listeners, Listener{Port: port, PID: pid})
	}
	return listeners
}
