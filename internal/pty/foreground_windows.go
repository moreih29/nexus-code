//go:build windows

package pty

import (
	"context"
	"debug/pe"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
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

// agentHosts names the programs that run an agent's script: an npm
// package's Codex is node running a script that runs Codex's own program.
// The program in front is the agent when it is the one the host runs, and
// the host otherwise, as when it runs a server or a command.
var agentHosts = map[string]bool{"node": true}

// agentPrograms names the agents' own programs.
var agentPrograms = map[string]bool{"codex": true, "claude": true}

// maxForegroundDepth bounds the walk down the process tree.
const maxForegroundDepth = 16

// foregroundOf names the program the shell with process id shell runs, or
// the shell itself when it runs none, or "" when the shell isn't listed.
//
// A console has no foreground process group. The program in front is taken
// to be the shell's newest child that is a console program, followed down
// through the programs in passThrough to the one they run, and through an
// agent host to the agent it runs. A window program
// the shell started runs apart from the console, and a child older than its
// parent belongs to an earlier process that had the parent's id.
//
// An MSYS program, Git Bash's bash among them, starts another MSYS program,
// such as a bash script, by a fork and an exec that leave the new process
// with a Windows parent that is gone. So where a process has no child to be
// seen, msys, if given, names the children the MSYS runtime knows it has.
func foregroundOf(
	entries []processEntry,
	shell uint32,
	detail func(pid uint32) (processDetail, bool),
	msys func(pid uint32) []uint32,
) string {
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
	// newest is the newest console child of a process, from its Windows
	// children or else the MSYS runtime's.
	newest := func(parent processEntry, parentDetail processDetail) (processEntry, processDetail, bool) {
		var next processEntry
		var nextDetail processDetail
		found := false
		consider := func(entry processEntry) {
			d, ok := detail(entry.pid)
			if !ok || !d.console || d.created < parentDetail.created {
				return
			}
			if !found || d.created > nextDetail.created {
				next, nextDetail, found = entry, d, true
			}
		}
		for _, entry := range entries {
			if entry.parent == parent.pid && entry.pid != parent.pid {
				consider(entry)
			}
		}
		if !found && msys != nil {
			for _, pid := range msys(parent.pid) {
				if entry, ok := byPID[pid]; ok && pid != parent.pid {
					consider(entry)
				}
			}
		}
		return next, nextDetail, found
	}
	for depth := 0; depth < maxForegroundDepth; depth++ {
		next, nextDetail, found := newest(current, currentDetail)
		if !found {
			return current.name
		}
		current, currentDetail = next, nextDetail
		name := strings.ToLower(current.name)
		if agentHosts[name] {
			if agent, _, ok := newest(current, currentDetail); ok && agentPrograms[strings.ToLower(agent.name)] {
				return agent.name
			}
			return current.name
		}
		if !passThrough[name] {
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
	if path, ok := imagePath(process); ok {
		console = isConsoleProgram(path)
	}
	return processDetail{created: int64(created.HighDateTime)<<32 | int64(created.LowDateTime), console: console}, true
}

// imagePath reads the path of an open process's program.
func imagePath(process windows.Handle) (string, bool) {
	buf := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(process, 0, &buf[0], &size); err != nil {
		return "", false
	}
	return windows.UTF16ToString(buf[:size]), true
}

// msysPsTimeout bounds the wait for an MSYS installation's ps.
const msysPsTimeout = 2 * time.Second

// msysChildren lists the Windows process ids of the processes the MSYS
// program with process id pid started, as the ps of its MSYS installation
// lists them, or nil when pid is no MSYS program. An installation's
// programs sit beside its runtime, msys-2.0.dll, and its ps.
func msysChildren(pid uint32) []uint32 {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(process)
	path, ok := imagePath(process)
	if !ok {
		return nil
	}
	dir := filepath.Dir(path)
	if _, err := os.Stat(filepath.Join(dir, "msys-2.0.dll")); err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), msysPsTimeout)
	defer cancel()
	listing, err := exec.CommandContext(ctx, filepath.Join(dir, "ps.exe")).Output()
	if err != nil {
		return nil
	}
	return msysChildrenIn(string(listing), pid)
}

// msysChildrenIn reads a listing of MSYS's ps, whose columns start with
// PID, PPID, PGID and WINPID (after a status letter on some rows), for the
// Windows ids of the children of the process whose Windows id is winpid. A
// process that exec'd a Windows program is listed by that program's id.
func msysChildrenIn(listing string, winpid uint32) []uint32 {
	type row struct {
		pid, ppid uint64
		winpid    uint32
	}
	var rows []row
	var parent uint64
	known := false
	for _, line := range strings.Split(listing, "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && strings.Trim(fields[0], "0123456789") != "" {
			fields = fields[1:]
		}
		if len(fields) < 4 {
			continue
		}
		pid, errPID := strconv.ParseUint(fields[0], 10, 64)
		ppid, errPPID := strconv.ParseUint(fields[1], 10, 64)
		win, errWin := strconv.ParseUint(fields[3], 10, 32)
		if errPID != nil || errPPID != nil || errWin != nil {
			continue
		}
		rows = append(rows, row{pid: pid, ppid: ppid, winpid: uint32(win)})
		if uint32(win) == winpid {
			parent, known = pid, true
		}
	}
	if !known {
		return nil
	}
	var children []uint32
	for _, r := range rows {
		if r.ppid == parent && r.pid != parent {
			children = append(children, r.winpid)
		}
	}
	return children
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
