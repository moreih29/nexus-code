//go:build windows

package hookclient

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// TestTreeHelper is the process a tree test runs: it starts a child that
// waits, writes the child's pid to NEXUS_TREE_PID_FILE, and waits itself.
func TestTreeHelper(t *testing.T) {
	switch os.Getenv("NEXUS_TREE_HELPER") {
	case "parent":
		child := exec.Command(os.Args[0], "-test.run=^TestTreeHelper$")
		child.Env = append(os.Environ(), "NEXUS_TREE_HELPER=child")
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		pid := []byte(strconv.Itoa(child.Process.Pid))
		if err := os.WriteFile(os.Getenv("NEXUS_TREE_PID_FILE"), pid, 0o644); err != nil {
			os.Exit(2)
		}
		time.Sleep(time.Minute)
		os.Exit(0)
	case "child":
		time.Sleep(time.Minute)
		os.Exit(0)
	}
}

// startTree runs the helper's tree, held as a run's program is; it returns
// the program and its child, opened to wait on.
func startTree(t *testing.T) (*exec.Cmd, *processTree, windows.Handle) {
	t.Helper()
	pidFile := filepath.Join(t.TempDir(), "pid")
	cmd := exec.Command(os.Args[0], "-test.run=^TestTreeHelper$")
	cmd.Env = append(os.Environ(), "NEXUS_TREE_HELPER=parent", "NEXUS_TREE_PID_FILE="+pidFile)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	tree := holdTree(cmd.Process)
	if tree == nil {
		_ = cmd.Process.Kill()
		t.Fatal("no tree")
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	pid := 0
	for deadline := time.Now().Add(10 * time.Second); pid == 0; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the program started no child")
		}
		if data, err := os.ReadFile(pidFile); err == nil {
			pid, _ = strconv.Atoi(string(data))
		}
	}
	child, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = windows.TerminateProcess(child, 1)
		_ = windows.CloseHandle(child)
	})
	return cmd, tree, child
}

func ended(process windows.Handle, within time.Duration) bool {
	event, err := windows.WaitForSingleObject(process, uint32(within.Milliseconds()))
	return err == nil && event == windows.WAIT_OBJECT_0
}

func TestStopProcess_EndsWhatTheRunStarted(t *testing.T) {
	cmd, tree, child := startTree(t)
	defer tree.release()
	if s := stopProcess(cmd.Process, tree); s != os.Kill {
		t.Fatalf("stopped by %v", s)
	}
	_ = cmd.Wait()
	if !ended(child, 5*time.Second) {
		t.Fatal("the program's child is still running")
	}
}

func TestProcessTree_ReleasedLeavesWhatRuns(t *testing.T) {
	cmd, tree, child := startTree(t)
	tree.release()
	if s := stopProcess(cmd.Process, tree); s != os.Kill {
		t.Fatalf("stopped by %v", s)
	}
	_ = cmd.Wait()
	if ended(child, 300*time.Millisecond) {
		t.Fatal("the program's child ended with it")
	}
}
