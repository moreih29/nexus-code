//go:build windows

package pty

import (
	"debug/pe"
	"encoding/binary"
	"errors"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// processEntry is a running process as a process snapshot lists it.
type processEntry struct {
	pid, parent uint32
	name        string // the image's file name, without ".exe"
}

// processDetail is what foregroundOf reads of a process it may pick.
type processDetail struct {
	created int64 // creation time, in 100 ns ticks
	console bool  // whether its program is a console program
}

// passThrough names the programs that stand in front of the one the user
// runs: Git Bash's bash.exe starts the real bash, a bash script that runs a
// Windows program waits for it, and a .cmd script's program runs under cmd.
var passThrough = map[string]bool{
	"bash":       true,
	"sh":         true,
	"cmd":        true,
	"powershell": true,
	"pwsh":       true,
}

// maxForegroundDepth bounds the walk down the process tree.
const maxForegroundDepth = 16

// foregroundOf names the program the shell with process id shell runs, or
// the shell itself when it runs none, or "" when the shell isn't listed.
//
// A console has no foreground process group. The program in front is taken
// to be the shell's newest child that is a console program, followed down
// through the programs in passThrough to the one they run. A window program
// the shell started runs apart from the console, and a child older than its
// parent belongs to an earlier process that had the parent's id.
func foregroundOf(entries []processEntry, shell uint32, detail func(pid uint32) (processDetail, bool)) string {
	byPID := make(map[uint32]processEntry, len(entries))
	for _, entry := range entries {
		byPID[entry.pid] = entry
	}
	current, ok := byPID[shell]
	if !ok {
		return ""
	}
	currentDetail, ok := detail(shell)
	if !ok {
		return current.name
	}
	for depth := 0; depth < maxForegroundDepth; depth++ {
		var next processEntry
		var nextDetail processDetail
		found := false
		for _, entry := range entries {
			if entry.parent != current.pid || entry.pid == current.pid {
				continue
			}
			d, ok := detail(entry.pid)
			if !ok || !d.console || d.created < currentDetail.created {
				continue
			}
			if !found || d.created > nextDetail.created {
				next, nextDetail, found = entry, d, true
			}
		}
		if !found {
			return current.name
		}
		current, currentDetail = next, nextDetail
		if !passThrough[strings.ToLower(current.name)] {
			return current.name
		}
	}
	return current.name
}

// listProcesses lists the running processes.
func listProcesses() ([]processEntry, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	var entries []processEntry
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		name := windows.UTF16ToString(entry.ExeFile[:])
		if len(name) > 4 && strings.EqualFold(name[len(name)-4:], ".exe") {
			name = name[:len(name)-4]
		}
		entries = append(entries, processEntry{pid: entry.ProcessID, parent: entry.ParentProcessID, name: name})
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return nil, err
	}
	return entries, nil
}

// readProcessDetail reads a process's creation time and whether its program
// is a console program; false when the process can't be opened.
func readProcessDetail(pid uint32) (processDetail, bool) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return processDetail{}, false
	}
	defer windows.CloseHandle(process)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &created, &exited, &kernel, &user); err != nil {
		return processDetail{}, false
	}
	console := true
	buf := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(process, 0, &buf[0], &size); err == nil {
		console = isConsoleProgram(windows.UTF16ToString(buf[:size]))
	}
	return processDetail{created: int64(created.HighDateTime)<<32 | int64(created.LowDateTime), console: console}, true
}

// isConsoleProgram reads the subsystem in the PE header of the program at
// path: whether it is anything but a window program, and true when the
// header can't be read.
func isConsoleProgram(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return true
	}
	defer f.Close()
	var word [4]byte
	// The DOS header gives the offset of the PE header.
	if _, err := f.ReadAt(word[:4], 0x3c); err != nil {
		return true
	}
	// The PE signature (4 bytes) and file header (20) come before the
	// optional header, whose subsystem is at 68 for 32 and 64 bits alike.
	at := int64(binary.LittleEndian.Uint32(word[:4])) + 4 + 20 + 68
	if _, err := f.ReadAt(word[:2], at); err != nil {
		return true
	}
	return binary.LittleEndian.Uint16(word[:2]) != pe.IMAGE_SUBSYSTEM_WINDOWS_GUI
}
