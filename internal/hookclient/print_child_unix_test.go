//go:build darwin || linux

package hookclient

import (
	"bufio"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestMain dispatches the private bootstrap for child processes of the test binary.
func TestMain(m *testing.M) {
	if code, handled := PrintChildHelper(os.Args[1:]); handled {
		os.Exit(code)
	}
	os.Exit(m.Run())
}

// TestPrintWrapperKillStopsChild uses an idle process with no hook server or
// pipe writes after startup, so only wrapper-death handling can stop it.
func TestPrintWrapperKillStopsChild(t *testing.T) {
	if os.Getenv("NEXUS_TEST_PRINT_PARENT_DEATH") == "1" {
		os.Exit(RunPrint([]string{"/bin/sh", "-c", `printf '%s\n' "$$"; exec /bin/sleep 60`}))
	}

	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	cmd := exec.Command(os.Args[0], "-test.run=^TestPrintWrapperKillStopsChild$")
	cmd.Env = append(os.Environ(), "NEXUS_TEST_PRINT_PARENT_DEATH=1", envAgentSocket+"=")
	cmd.Stdout, cmd.Stderr = write, os.Stderr
	err = cmd.Start()
	_ = write.Close()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()
	_ = read.SetReadDeadline(time.Now().Add(5 * time.Second))
	out := bufio.NewReader(read)
	line, err := out.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil || pid <= 1 {
		t.Fatalf("invalid test child pid %q", line)
	}
	ended := false
	defer func() {
		if !ended {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}()

	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	_ = read.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := out.ReadByte(); !errors.Is(err, io.EOF) {
		t.Fatalf("child survived killing its wrapper: %v", err)
	}
	ended = true
}
