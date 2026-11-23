//go:build darwin

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

	agentchat "github.com/nexus-code/nexus-code/internal/chat"
	"github.com/nexus-code/nexus-code/internal/proto"
)

type localAgent struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	frames *json.Decoder
}

func startLocalAgent(t *testing.T, bin, root, home string) *localAgent {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	cmd := exec.CommandContext(ctx, bin, root)
	cmd.Env = append(os.Environ(), "HOME="+home, "NEXUS_CODE_HOME="+home+"/nexus")
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
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	agent := &localAgent{cmd: cmd, stdin: stdin, frames: json.NewDecoder(stdout)}
	var ready proto.ReadyFrame
	if err := agent.frames.Decode(&ready); err != nil || ready.Type != "ready" {
		t.Fatalf("ready frame = %+v, %v", ready, err)
	}
	return agent
}

func (a *localAgent) startChat(t *testing.T, root string) int {
	t.Helper()
	params, err := json.Marshal(agentchat.StartParams{
		WorkspaceID: "ws", TabID: "tab", Cwd: root, Program: "/bin/sh", Args: []string{"-c", "/bin/sleep 60 & wait"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(a.stdin).Encode(proto.Request{ID: "start", Method: "chat.start", Params: params}); err != nil {
		t.Fatal(err)
	}
	for {
		var frame struct {
			ID     string                `json:"id"`
			Error  *proto.ErrorFrame     `json:"error"`
			Result agentchat.StartResult `json:"result"`
		}
		if err := a.frames.Decode(&frame); err != nil {
			t.Fatal(err)
		}
		if frame.ID != "start" {
			continue
		}
		if frame.Error != nil || frame.Result.PID == 0 {
			t.Fatalf("chat.start = %+v", frame)
		}
		return frame.Result.PID
	}
}

func alive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

func TestANewAgentEndsTheChatProgramsItsKilledPredecessorLeftBeforeItIsReady(t *testing.T) {
	bin := agentBinary(t)
	home := shortHome(t)
	root := t.TempDir()
	first := startLocalAgent(t, bin, root, home)
	pid := first.startChat(t, root)
	t.Cleanup(func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })

	_ = first.cmd.Process.Signal(syscall.SIGKILL)
	_ = first.cmd.Wait()
	time.Sleep(200 * time.Millisecond)
	if !alive(pid) {
		t.Fatal("the chat program ended with its agent; nothing left to test")
	}

	startLocalAgent(t, bin, t.TempDir(), home)
	if !alive(pid) {
		t.Fatal("an agent of another workspace ended the chat program")
	}

	startLocalAgent(t, bin, root, home)
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("chat program %d still runs when the new agent is ready: %v", pid, err)
	}
	if err := syscall.Kill(-pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("a process of the chat program's group %d still runs: %v", pid, err)
	}
}
