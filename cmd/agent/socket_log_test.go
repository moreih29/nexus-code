//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/proto"
)

func TestLocalAgentLogsWhereItPutsTheHookSocketOnlyOffItsHome(t *testing.T) {
	bin := agentBinary(t)
	if lines := hookSocketLines(t, bin, ""); len(lines) != 0 {
		t.Fatalf("logged %v for the socket in its own home, want nothing", lines)
	}

	long := filepath.Join(shortHome(t), strings.Repeat("h", agentpaths.MaxSocketPathLen()))
	lines := hookSocketLines(t, bin, long)
	if len(lines) != 1 {
		t.Fatalf("logged %v, want one line about the fallback", lines)
	}
	line := lines[0]
	path, _ := line["path"].(string)
	fallback, _ := line["fallback"].(string)
	t.Cleanup(func() {
		_ = os.Remove(fallback)
		_ = os.Remove(filepath.Dir(fallback))
	})
	if line["level"] != "INFO" || line["src"] != "agent-log" ||
		!strings.HasPrefix(path, filepath.Join(long, "sockets", "h-")) ||
		line["bytes"] != float64(len(path)) ||
		line["limit"] != float64(agentpaths.MaxSocketPathLen()) ||
		!strings.HasPrefix(fallback, fmt.Sprintf("/tmp/nexus-code-%d-", os.Getuid())) ||
		filepath.Base(fallback) != filepath.Base(path) {
		t.Fatalf("fallback line = %v", line)
	}
}

func hookSocketLines(t *testing.T, bin, nexusHome string) []map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, t.TempDir())
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, agentpaths.HomeEnv+"=") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	cmd.Env = append(cmd.Env, "HOME="+shortHome(t))
	if nexusHome != "" {
		cmd.Env = append(cmd.Env, agentpaths.HomeEnv+"="+nexusHome)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
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
	var ready proto.ReadyFrame
	if err := json.NewDecoder(stdout).Decode(&ready); err != nil || ready.Type != "ready" {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("ready frame = %+v, %v\n%s", ready, err, stderr.String())
	}
	_ = stdin.Close()
	_ = cmd.Wait()

	var lines []map[string]any
	for _, text := range strings.Split(stderr.String(), "\n") {
		var line map[string]any
		if json.Unmarshal([]byte(text), &line) != nil {
			continue
		}
		if msg, _ := line["msg"].(string); strings.HasPrefix(msg, "hookserver ") {
			lines = append(lines, line)
		}
	}
	return lines
}
