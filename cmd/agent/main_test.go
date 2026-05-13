package main

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestServerNDJSONAndSIGTERM(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("SIGTERM behavior is Unix-specific")
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "alpha.txt"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}

	bin := filepath.Join(t.TempDir(), "agent")
	build := exec.Command("go", "build", "-o", bin, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build failed: %v\n%s", err, output)
	}

	cmd := exec.Command(bin, root)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		t.Fatalf("missing ready frame: %v", scanner.Err())
	}
	var ready map[string]any
	if err := json.Unmarshal(scanner.Bytes(), &ready); err != nil {
		t.Fatal(err)
	}
	if ready["type"] != "ready" || ready["protocolVersion"] != "1" || ready["serverVersion"] != "0.1.0" {
		t.Fatalf("ready mismatch: %#v", ready)
	}

	_, err = stdin.Write([]byte(`{"id":"escape","method":"fs.stat","params":{"relPath":"../etc/passwd"}}` + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !scanner.Scan() {
		t.Fatalf("missing escape response: %v", scanner.Err())
	}
	line := scanner.Text()
	if !strings.Contains(line, `"id":"escape"`) || !strings.Contains(line, `"error":{"code":"OUT_OF_WORKSPACE"`) {
		t.Fatalf("escape response mismatch: %s", line)
	}

	_, err = stdin.Write([]byte(`{"id":"read","method":"fs.readFile","params":{"relPath":"alpha.txt"}}` + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !scanner.Scan() {
		t.Fatalf("missing read response: %v", scanner.Err())
	}
	if !strings.Contains(scanner.Text(), `"content":"alpha"`) {
		t.Fatalf("read response mismatch")
	}

	start := time.Now()
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("server exited with error: %v", err)
		}
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Fatalf("SIGTERM drain took too long: %s", elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not exit after SIGTERM")
	}
}
