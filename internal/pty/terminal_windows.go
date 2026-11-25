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

const consoleDrainGrace = 5 * time.Second

type terminal struct {
	in  *os.File
	out *os.File

	mu     sync.Mutex
	closed bool
	hpc    windows.Handle

	shellPID uint32
}

func defaultShell() string {
	if path, err := exec.LookPath("powershell.exe"); err == nil {
		return path
	}
	if comspec := strings.TrimSpace(os.Getenv("COMSPEC")); comspec != "" {
		return comspec
	}
	return "cmd.exe"
}

var allowCtrlC sync.Once

var procSetConsoleCtrlHandler = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleCtrlHandler")

func startTerminal(spec spawnSpec) (*terminal, *child, error) {
	allowCtrlC.Do(func() {
		_, _, _ = procSetConsoleCtrlHandler.Call(0, 0)
	})
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
	t.shellPID = uint32(process.Pid)
	return t, &child{process}, nil
}

func startInConsole(path string, spec spawnSpec, hpc windows.Handle) (*os.Process, error) {
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, err
	}
	defer attrs.Delete()
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&hpc)), unsafe.Sizeof(hpc)); err != nil {
		return nil, err
	}
	si := windows.StartupInfoEx{
		StartupInfo: windows.StartupInfo{
			Cb:    uint32(unsafe.Sizeof(windows.StartupInfoEx{})),
			Flags: windows.STARTF_USESTDHANDLES,
		},
		ProcThreadAttributeList: attrs.List(),
	}

	appName, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	cmdLine, err := windows.UTF16PtrFromString(windowsCommandLine(path, spec.args))
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
	defer windows.CloseHandle(pi.Process)
	return os.FindProcess(int(pi.ProcessId))
}

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

func (t *terminal) Read(p []byte) (int, error) {
	return t.out.Read(p)
}

func (t *terminal) Write(p []byte) (int, error) {
	return t.in.Write(p)
}

func (t *terminal) setSize(cols, rows int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return os.ErrClosed
	}
	return windows.ResizePseudoConsole(t.hpc, windows.Coord{X: int16(cols), Y: int16(rows)})
}

func (t *terminal) foregroundProcess(alone bool) (string, *bool) {
	if t.shellPID == 0 {
		return "", nil
	}
	entries, err := listProcesses()
	if err != nil {
		return "", nil
	}
	name := foregroundOf(entries, t.shellPID, readProcessDetail, msysChildren)
	if !alone || name == "" {
		return name, nil
	}
	only := true
	return name, &only
}

func (t *terminal) Close() error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	t.mu.Unlock()

	_ = t.in.Close()
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		_, _ = io.Copy(io.Discard, t.out)
	}()
	windows.ClosePseudoConsole(t.hpc)
	select {
	case <-drained:
	case <-time.After(consoleDrainGrace):
	}
	if err := t.out.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
		return err
	}
	return nil
}

func sameEnvKey(a, b string) bool {
	return strings.EqualFold(a, b)
}
