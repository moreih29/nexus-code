//go:build windows

package pty

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// consoleDrainGrace bounds how long Close waits for a closed console's output
// to end.
const consoleDrainGrace = 5 * time.Second

// terminal is the Windows pseudoconsole (ConPTY) a session's shell runs
// under. The shell's input goes in through one pipe, and the console renders
// its output as VT sequences into another.
type terminal struct {
	in  *os.File // write end of the console's input pipe
	out *os.File // read end of the console's output pipe

	mu     sync.Mutex // keeps setSize off a closed console
	closed bool
	hpc    windows.Handle
}

// defaultShell resolves the shell for a PTY when the client names none:
// Windows PowerShell, which every supported Windows ships, else %COMSPEC%.
func defaultShell() string {
	if path, err := exec.LookPath("powershell.exe"); err == nil {
		return path
	}
	if comspec := strings.TrimSpace(os.Getenv("COMSPEC")); comspec != "" {
		return comspec
	}
	return "cmd.exe"
}

// startTerminal starts spec's shell in a new pseudoconsole.
func startTerminal(spec spawnSpec) (*terminal, *child, error) {
	path, err := exec.LookPath(spec.shell)
	if err != nil {
		return nil, nil, err
	}

	var inRead, inWrite, outRead, outWrite windows.Handle
	if err := windows.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
		return nil, nil, fmt.Errorf("create input pipe: %w", err)
	}
	if err := windows.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
		_ = windows.CloseHandle(inRead)
		_ = windows.CloseHandle(inWrite)
		return nil, nil, fmt.Errorf("create output pipe: %w", err)
	}
	var hpc windows.Handle
	err = windows.CreatePseudoConsole(windows.Coord{X: int16(spec.cols), Y: int16(spec.rows)}, inRead, outWrite, 0, &hpc)
	// The console keeps its own handles to the ends it uses.
	_ = windows.CloseHandle(inRead)
	_ = windows.CloseHandle(outWrite)
	if err != nil {
		_ = windows.CloseHandle(inWrite)
		_ = windows.CloseHandle(outRead)
		return nil, nil, fmt.Errorf("create pseudoconsole: %w", err)
	}
	t := &terminal{
		in:  os.NewFile(uintptr(inWrite), "conpty-in"),
		out: os.NewFile(uintptr(outRead), "conpty-out"),
		hpc: hpc,
	}

	process, err := startInConsole(path, spec, hpc)
	if err != nil {
		_ = t.Close()
		return nil, nil, err
	}
	return t, &child{process}, nil
}

// startInConsole starts the program at path, with spec's arguments,
// directory and environment, attached to the pseudoconsole hpc.
func startInConsole(path string, spec spawnSpec, hpc windows.Handle) (*os.Process, error) {
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, err
	}
	defer attrs.Delete()
	// The attribute's value is the console handle itself, not a pointer to it.
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&hpc)), unsafe.Sizeof(hpc)); err != nil {
		return nil, err
	}
	si := windows.StartupInfoEx{
		StartupInfo: windows.StartupInfo{
			Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{})),
			// No standard handles: without this flag the shell would take the
			// agent's own (the pipes to the app) instead of the console's.
			Flags: windows.STARTF_USESTDHANDLES,
		},
		ProcThreadAttributeList: attrs.List(),
	}

	appName, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{path}, spec.args...)))
	if err != nil {
		return nil, err
	}
	dir, err := windows.UTF16PtrFromString(spec.dir)
	if err != nil {
		return nil, err
	}
	env, err := environmentBlock(spec.env)
	if err != nil {
		return nil, err
	}

	var pi windows.ProcessInformation
	err = windows.CreateProcess(appName, cmdLine, nil, nil, false,
		windows.EXTENDED_STARTUPINFO_PRESENT|windows.CREATE_UNICODE_ENVIRONMENT,
		env, dir, &si.StartupInfo, &pi)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(pi.Thread)
	// pi.Process stays open until FindProcess has its own handle, so the
	// process id cannot be reused meanwhile.
	defer windows.CloseHandle(pi.Process)
	return os.FindProcess(int(pi.ProcessId))
}

// environmentBlock encodes env as CreateProcess takes it: each "key=value"
// NUL-terminated, the block ending in one more NUL.
func environmentBlock(env []string) (*uint16, error) {
	var block []uint16
	for _, entry := range env {
		encoded, err := windows.UTF16FromString(entry)
		if err != nil {
			return nil, fmt.Errorf("environment entry %q: %w", entry, err)
		}
		block = append(block, encoded...)
	}
	if len(block) == 0 {
		block = append(block, 0)
	}
	block = append(block, 0)
	return &block[0], nil
}

// Read reads the console's rendered output.
func (t *terminal) Read(p []byte) (int, error) {
	return t.out.Read(p)
}

// Write sends input to the console.
func (t *terminal) Write(p []byte) (int, error) {
	return t.in.Write(p)
}

// setSize resizes the console.
func (t *terminal) setSize(cols, rows int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return os.ErrClosed
	}
	return windows.ResizePseudoConsole(t.hpc, windows.Coord{X: int16(cols), Y: int16(rows)})
}

// foregroundProcess reports no name: a console has no foreground process
// group to read it from.
func (t *terminal) foregroundProcess() string {
	return ""
}

// Close closes the console and its pipes. The output pipe reads end once the
// console has gone.
func (t *terminal) Close() error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	t.mu.Unlock()

	_ = t.in.Close()
	// Before Windows 11 24H2, ClosePseudoConsole waits until its last output
	// has been read, and the session may have stopped reading.
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		_, _ = io.Copy(io.Discard, t.out)
	}()
	windows.ClosePseudoConsole(t.hpc)
	// A process still attached to the console can keep its output open; past
	// the grace the pipe is left to close once that process ends.
	select {
	case <-drained:
	case <-time.After(consoleDrainGrace):
	}
	if err := t.out.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
		return err
	}
	return nil
}

// sameEnvKey reports whether two environment variable names name the same
// variable: Windows ignores case, so Path and PATH are one.
func sameEnvKey(a, b string) bool {
	return strings.EqualFold(a, b)
}
