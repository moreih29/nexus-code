package ports

import (
	"encoding/binary"
	"reflect"
	"testing"
)

func TestParsePSKeepsSpacesInAProgramsPath(t *testing.T) {
	out := "    1     0 /sbin/launchd\n" +
		" 1702     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n" +
		" 4200  1702 node\n" +
		"not a row\n"

	table := parsePS([]byte(out))
	want := map[int]Process{
		1:    {PPID: 0, Name: "launchd"},
		1702: {PPID: 1, Name: "Google Chrome"},
		4200: {PPID: 1702, Name: "node"},
	}
	if !reflect.DeepEqual(table, want) {
		t.Fatalf("parsePS() = %+v, want %+v", table, want)
	}
}

func TestParseLsofReadsEachProcesssSockets(t *testing.T) {
	out := "p980\nf13\nn*:5173\nf15\nn[::1]:5173\np1362\nf9\nn127.0.0.1:8787\nnnot-a-port\n"

	listeners := parseLsof([]byte(out))
	want := []Listener{{Port: 5173, PID: 980}, {Port: 5173, PID: 980}, {Port: 8787, PID: 1362}}
	if !reflect.DeepEqual(listeners, want) {
		t.Fatalf("parseLsof() = %+v, want %+v", listeners, want)
	}
}

func TestParseProcStatReadsANameWithParentheses(t *testing.T) {
	stat := "4242 (node (vite)) S 4200 4242 4242 0 -1 4194304 1 0 0 0\n"

	process, ok := parseProcStat([]byte(stat))
	if !ok || process != (Process{PPID: 4200, Name: "node (vite)"}) {
		t.Fatalf("parseProcStat() = %+v, %v", process, ok)
	}
}

func TestParseProcNetTCPKeepsListeningSockets(t *testing.T) {
	tcp := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
		"   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 31337 1 0000000000000000 100 0 0 10 0\n" +
		"   1: 0100007F:2253 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 31338 1 0000000000000000 100 0 0 10 0\n" +
		// An established connection.
		"   2: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 31339 1 0000000000000000 20 4 30 10 -1\n"
	tcp6 := "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
		"   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41000 1 0000000000000000 100 0 0 10 0\n"

	if got, want := parseProcNetTCP([]byte(tcp)), map[uint64]int{31337: 5173, 31338: 8787}; !reflect.DeepEqual(got, want) {
		t.Fatalf("parseProcNetTCP(tcp) = %v, want %v", got, want)
	}
	if got, want := parseProcNetTCP([]byte(tcp6)), map[uint64]int{41000: 8080}; !reflect.DeepEqual(got, want) {
		t.Fatalf("parseProcNetTCP(tcp6) = %v, want %v", got, want)
	}
}

func TestSocketInode(t *testing.T) {
	if inode, ok := socketInode("socket:[31337]"); !ok || inode != 31337 {
		t.Fatalf("socketInode(socket) = %d, %v", inode, ok)
	}
	for _, link := range []string{"pipe:[31337]", "/dev/null", "socket:[x]"} {
		if _, ok := socketInode(link); ok {
			t.Fatalf("socketInode(%q) read an inode", link)
		}
	}
}

// tableOf builds a Windows TCP table of rows of rowSize bytes, each filled
// in by fill.
func tableOf(rowSize int, fills ...func(row []byte)) []byte {
	buf := make([]byte, 4+len(fills)*rowSize)
	binary.LittleEndian.PutUint32(buf, uint32(len(fills)))
	for i, fill := range fills {
		fill(buf[4+i*rowSize : 4+(i+1)*rowSize])
	}
	return buf
}

func row(stateAt, portAt, pidAt int, state uint32, port uint16, pid uint32) func([]byte) {
	return func(r []byte) {
		binary.LittleEndian.PutUint32(r[stateAt:], state)
		binary.BigEndian.PutUint16(r[portAt:], port)
		binary.LittleEndian.PutUint32(r[pidAt:], pid)
	}
}

func TestParseTCPTableReadsPortsInNetworkOrder(t *testing.T) {
	buf := tableOf(24,
		row(0, 8, 20, mibTCPStateListen, 5173, 4200),
		row(0, 8, 20, 5, 8787, 4300), // established
	)

	want := []Listener{{Port: 5173, PID: 4200}}
	if got := parseTCPTable(buf); !reflect.DeepEqual(got, want) {
		t.Fatalf("parseTCPTable() = %+v, want %+v", got, want)
	}
	// A count past the end of the buffer reads only the rows that are there.
	binary.LittleEndian.PutUint32(buf, 9)
	if got := parseTCPTable(buf); !reflect.DeepEqual(got, want) {
		t.Fatalf("parseTCPTable(short) = %+v, want %+v", got, want)
	}
}

func TestParseTCP6Table(t *testing.T) {
	buf := tableOf(56, row(48, 20, 52, mibTCPStateListen, 3000, 4200))

	want := []Listener{{Port: 3000, PID: 4200}}
	if got := parseTCP6Table(buf); !reflect.DeepEqual(got, want) {
		t.Fatalf("parseTCP6Table() = %+v, want %+v", got, want)
	}
}
