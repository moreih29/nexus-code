//go:build darwin || linux

package agent_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/pty"
)

func spawnTerminalShell(t *testing.T, service *pty.Service, root, tab, script string) {
	t.Helper()
	call(t, service.Spawn, pty.SpawnParams{
		WorkspaceID: "workspace", TabID: tab, Cwd: root, Cols: 80, Rows: 24,
		Shell: "/bin/sh", Args: []string{"-c", script},
	})
}

func TestTerminalOutputResumesWhenDialerLeaves(t *testing.T) {
	root := t.TempDir()
	service := pty.New()
	defer service.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	paused := make(chan struct{}, 1)
	var received atomic.Int64
	service.SetEventSink(ctx, func(event string, payload any) error {
		if event != pty.EventData {
			return nil
		}
		bytes, err := base64.StdEncoding.DecodeString(payload.(pty.DataPayload).Chunk)
		if err != nil {
			return err
		}
		if received.Add(int64(len(bytes))) >= pty.HighWatermarkBytes {
			select {
			case paused <- struct{}{}:
			default:
			}
		}
		return nil
	})
	if err := os.WriteFile(filepath.Join(root, "output"), bytes.Repeat([]byte{'x'}, 256<<10), 0600); err != nil {
		t.Fatal(err)
	}
	spawnTerminalShell(t, service, root, "detach", "cat output && printf finished > done")
	select {
	case <-paused:
	case <-time.After(3 * time.Second):
		t.Fatalf("output stopped after %d bytes", received.Load())
	}

	marker := filepath.Join(root, "done")
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("the command finished before disconnect: %v", err)
	}
	cancel()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got, err := os.ReadFile(marker); err == nil && string(got) == "finished" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Errorf("the command remained blocked after disconnecting with %d bytes received", received.Load())
}

func TestNaturalTerminalExitClosesMaster(t *testing.T) {
	previous := debug.SetGCPercent(-1)
	defer debug.SetGCPercent(previous)
	fdDir := "/dev/fd"
	if runtime.GOOS == "linux" {
		fdDir = "/proc/self/fd"
	}
	countFDs := func() int {
		t.Helper()
		entries, err := os.ReadDir(fdDir)
		if err != nil {
			t.Skipf("cannot observe open file descriptors: %v", err)
		}
		return len(entries)
	}
	service := pty.New()
	defer service.Close()
	exits := make(chan struct{}, 1)
	service.SetEventSink(context.Background(), func(event string, _ any) error {
		if event == pty.EventExit {
			exits <- struct{}{}
		}
		return nil
	})
	root := t.TempDir()
	run := func(tab string) {
		t.Helper()
		spawnTerminalShell(t, service, root, tab, "exit 0")
		select {
		case <-exits:
		case <-time.After(3 * time.Second):
			t.Fatal("no terminal exit")
		}
	}
	run("initial")
	before := countFDs()
	for i := range 8 {
		run(strconv.Itoa(i))
	}
	if after := countFDs(); after > before+2 {
		t.Fatalf("descriptors after repeated terminal exits: before %d, after %d", before, after)
	}
}
