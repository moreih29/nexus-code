//go:build windows

package ports

import (
	"errors"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	iphlpapi                = windows.NewLazySystemDLL("iphlpapi.dll")
	procGetExtendedTcpTable = iphlpapi.NewProc("GetExtendedTcpTable")
)

const tcpTableOwnerPIDListener = 3

func Find(roots []int) ([]Port, error) {
	table, err := processTable()
	if err != nil {
		return nil, err
	}
	owner := under(table, roots)
	if onlyShells(owner) {
		return nil, nil
	}
	var listeners []Listener
	v4, err := tcpTable(windows.AF_INET)
	if err != nil {
		return nil, err
	}
	listeners = append(listeners, parseTCPTable(v4)...)
	if v6, err := tcpTable(windows.AF_INET6); err == nil {
		listeners = append(listeners, parseTCP6Table(v6)...)
	}
	var ports []Port
	for _, port := range match(listeners, table, owner) {
		if descends(table, port.PID, port.Root) {
			ports = append(ports, port)
		}
	}
	return ports, nil
}

func tcpTable(family int) ([]byte, error) {
	var size uint32
	var buf []byte
	for attempt := 0; attempt < 4; attempt++ {
		var ptr uintptr
		if size > 0 {
			buf = make([]byte, size)
			ptr = uintptr(unsafe.Pointer(&buf[0]))
		}
		r, _, _ := procGetExtendedTcpTable.Call(ptr, uintptr(unsafe.Pointer(&size)), 0,
			uintptr(family), tcpTableOwnerPIDListener, 0)
		switch windows.Errno(r) {
		case windows.ERROR_SUCCESS:
			return buf, nil
		case windows.ERROR_INSUFFICIENT_BUFFER:
			continue
		default:
			return nil, windows.Errno(r)
		}
	}
	return nil, errors.New("the TCP table kept growing")
}

func descends(table map[int]Process, pid, root int) bool {
	for steps := 0; pid != root; steps++ {
		parent, ok := table[pid]
		if !ok || steps > 64 {
			return false
		}
		child, okChild := created(pid)
		older, okParent := created(parent.PPID)
		if okChild && okParent && child < older {
			return false
		}
		pid = parent.PPID
	}
	return true
}

func created(pid int) (int64, bool) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return 0, false
	}
	defer windows.CloseHandle(process)
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &creation, &exit, &kernel, &user); err != nil {
		return 0, false
	}
	return int64(creation.HighDateTime)<<32 | int64(creation.LowDateTime), true
}

func processTable() (map[int]Process, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	table := map[int]Process{}
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		name := windows.UTF16ToString(entry.ExeFile[:])
		if len(name) > 4 && strings.EqualFold(name[len(name)-4:], ".exe") {
			name = name[:len(name)-4]
		}
		table[int(entry.ProcessID)] = Process{PPID: int(entry.ParentProcessID), Name: name}
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return nil, err
	}
	return table, nil
}
