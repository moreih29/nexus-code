package ports

import (
	"bytes"
	"encoding/binary"
	"strconv"
	"strings"
)

// baseName strips a program's folder: ps names some programs by their path.
func baseName(name string) string {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		return name[i+1:]
	}
	return name
}

// parsePS reads `ps -A -o pid=,ppid=,comm=`. The name is the rest of the
// line, as a program's path may hold spaces.
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

// parseLsof reads `lsof -Fpn` for TCP sockets: a "p<pid>" line starts each
// process, and an "n<address>:<port>" line follows for each of its sockets.
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

// parseProcStat reads the parent and the program's name from the contents
// of /proc/<pid>/stat. The name, field 2, is in parentheses and may hold
// spaces and parentheses itself, so the fields after it are counted from the
// last ")": field 3 (state) comes first, then field 4 (ppid).
func parseProcStat(data []byte) (Process, bool) {
	open := bytes.IndexByte(data, '(')
	end := bytes.LastIndexByte(data, ')')
	if open < 0 || end < open {
		return Process{}, false
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 2 {
		return Process{}, false
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return Process{}, false
	}
	return Process{PPID: ppid, Name: string(data[open+1 : end])}, true
}

// tcpListen is the state /proc/net/tcp gives a listening socket.
const tcpListen = "0A"

// parseProcNetTCP reads /proc/net/tcp or /proc/net/tcp6 and maps the inode
// of each listening socket to its port. A row's local address is hex
// "<address>:<port>", its state is the fourth field and its inode the tenth.
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

// socketInode reads the inode from a /proc/<pid>/fd link to a socket,
// "socket:[12345]".
func socketInode(link string) (uint64, bool) {
	rest, ok := strings.CutPrefix(link, "socket:[")
	if !ok || !strings.HasSuffix(rest, "]") {
		return 0, false
	}
	inode, err := strconv.ParseUint(rest[:len(rest)-1], 10, 64)
	return inode, err == nil
}

// mibTCPStateListen is MIB_TCP_STATE_LISTEN.
const mibTCPStateListen = 2

// parseTCPTable reads a MIB_TCPTABLE_OWNER_PID: a count, then rows of six
// little-endian DWORDs: state, local address, local port, remote address,
// remote port and owning process id. A port is in network byte order in the
// first two bytes of its DWORD.
func parseTCPTable(buf []byte) []Listener {
	const rowSize = 24
	return parseTable(buf, rowSize, 0, 8, 20)
}

// parseTCP6Table reads a MIB_TCP6TABLE_OWNER_PID, whose rows hold the local
// address (16 bytes), its scope, the local port, the remote address, its
// scope, the remote port, the state and the owning process id.
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
