//go:build windows

package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestWindowsChatStdinReachesNodeThroughCmd exercises libuv reading the
// inherited stdin handle through a batch launcher, including end of input.
func TestWindowsChatStdinReachesNodeThroughCmd(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not on PATH")
	}
	cmd, err := exec.LookPath("cmd.exe")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "echo-input.cmd"), []byte("@echo off\r\nnode \"%~dp0echo-input.cjs\"\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	const script = `
process.stdin.pipe(process.stdout, { end: false });
process.stdin.on("end", () => process.stdout.write('{"eof":true}\n'));
`
	if err := os.WriteFile(filepath.Join(dir, "echo-input.cjs"), []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}

	service := New()
	defer service.Close()
	rec := newRecorder()
	lastEcho := make(chan struct{}, 1)
	service.SetEventSink(func(event string, payload any) error {
		if line, ok := payload.(LinePayload); ok && line.Dir == DirOut && string(line.Message) == `"three"` {
			select {
			case lastEcho <- struct{}{}:
			default:
			}
		}
		return rec.sink(event, payload)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	key := tabKey{workspaceID: "ws", tabID: "windows-node-stdin"}
	start, err := json.Marshal(StartParams{
		WorkspaceID: key.workspaceID,
		TabID:       key.tabID,
		Cwd:         dir,
		Program:     cmd,
		Args:        []string{"/d", "/c", "echo-input.cmd"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Start(ctx, start); err != nil {
		t.Fatal(err)
	}
	proc := service.lookup(key).running()
	if proc == nil {
		t.Fatal("launcher exited before receiving input")
	}

	var want []json.RawMessage
	for _, line := range []string{strings.Repeat("x", 1<<20), "one", "두 번째", "three"} {
		message, err := json.Marshal(line)
		if err != nil {
			t.Fatal(err)
		}
		want = append(want, message)
		params, err := json.Marshal(SendParams{WorkspaceID: key.workspaceID, TabID: key.tabID, Message: message})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := service.Send(ctx, params); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-lastEcho:
	case <-proc.done:
		t.Fatal("Node exited before echoing the input")
	case <-ctx.Done():
		t.Fatal("Node did not echo the input")
	}

	want = append(want, json.RawMessage(`{"eof":true}`))
	if err := proc.stdin.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-proc.done:
	case <-ctx.Done():
		t.Fatal("Node did not exit after stdin EOF")
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()
	var got []json.RawMessage
	for _, line := range rec.lines {
		if line.Dir == DirOut {
			got = append(got, line.Message)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("Node echoed %d lines, want %d including EOF, exit: %+v", len(got), len(want), rec.exits)
	}
	for i, message := range got {
		if !bytes.Equal(message, want[i]) {
			t.Fatalf("echoed line %d differs from input (%d vs %d bytes)", i+1, len(message), len(want[i]))
		}
	}
	if len(rec.exits) != 1 || rec.exits[0].Code == nil || *rec.exits[0].Code != 0 {
		t.Fatalf("expected a successful exit, got %+v", rec.exits)
	}
}
