//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/lsp"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// TestLocalEOFKillsLanguageServer verifies that the local agent reaps an LSP
// child that stays alive after stdin closes before exiting itself.
func TestLocalEOFKillsLanguageServer(t *testing.T) {
	root := t.TempDir()
	bin := agentBinary(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, root)
	cmd.Env = append(os.Environ(), "HOME="+shortHome(t))
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	frames := json.NewDecoder(stdout)
	var ready proto.ReadyFrame
	if err := frames.Decode(&ready); err != nil || ready.Type != "ready" {
		t.Fatalf("ready frame = %+v, %v", ready, err)
	}
	params, err := json.Marshal(lsp.SpawnParams{
		WorkspaceID: "test", LanguageID: "fake", BinaryPath: os.Args[0], WorkspaceRoot: root,
		Args: []string{"-test.run=^TestLocalShutdownLanguageServerHelper$"},
		Env:  map[string]string{"NEXUS_TEST_LOCAL_SHUTDOWN_LSP": "1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(stdin).Encode(proto.Request{ID: "spawn", Method: "lsp.spawn", Params: params}); err != nil {
		t.Fatal(err)
	}
	pid := 0
	for pid == 0 {
		var frame struct {
			ID     string            `json:"id"`
			Error  *proto.ErrorFrame `json:"error"`
			Result struct {
				Capabilities struct {
					PID int `json:"testPid"`
				} `json:"capabilities"`
			} `json:"result"`
		}
		if err := frames.Decode(&frame); err != nil {
			t.Fatal(err)
		}
		if frame.ID == "spawn" {
			pid = frame.Result.Capabilities.PID
			if frame.Error != nil || pid == 0 {
				t.Fatalf("spawn result = %+v", frame)
			}
		}
	}
	childReaped := false
	defer func() {
		if !childReaped {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}()
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("agent exit: %v", err)
		}
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		<-done
		t.Fatal("agent failed to exit")
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("LSP child %d survived the agent: %v", pid, err)
	}
	childReaped = true
}

// TestLocalShutdownLanguageServerHelper runs a child that initializes normally
// and deliberately survives closed stdin.
func TestLocalShutdownLanguageServerHelper(t *testing.T) {
	if os.Getenv("NEXUS_TEST_LOCAL_SHUTDOWN_LSP") != "1" {
		return
	}
	decoder := lsp.NewDecoder()
	buf := make([]byte, 4*1024)
	for {
		n, err := os.Stdin.Read(buf)
		if errors.Is(err, io.EOF) {
			<-time.After(time.Minute)
			os.Exit(0)
		}
		if err != nil {
			t.Fatal(err)
		}
		messages, err := decoder.Append(buf[:n])
		if err != nil {
			t.Fatal(err)
		}
		for _, message := range messages {
			var req struct {
				ID     string `json:"id"`
				Method string `json:"method"`
			}
			if err := json.Unmarshal(message, &req); err != nil {
				t.Fatal(err)
			}
			if req.Method == "initialize" {
				response, err := lsp.EncodeMessage(map[string]any{
					"jsonrpc": "2.0", "id": req.ID,
					"result": map[string]any{"capabilities": map[string]int{"testPid": os.Getpid()}},
				})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stdout.Write(response); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
}
