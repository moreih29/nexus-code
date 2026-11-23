package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

var buildEnv = os.Environ()

var agentBuild struct {
	once sync.Once
	dir  string
	bin  string
	out  []byte
	err  error
}

func TestMain(m *testing.M) {
	parent := "/tmp"
	if runtime.GOOS == "windows" {
		parent = ""
	}
	home, err := os.MkdirTemp(parent, "nxah-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Setenv("HOME", home)
	os.Setenv("USERPROFILE", home)
	code := m.Run()
	_ = os.RemoveAll(home)
	if agentBuild.dir != "" {
		_ = os.RemoveAll(agentBuild.dir)
	}
	os.Exit(code)
}

func agentBinary(t *testing.T) string {
	t.Helper()
	agentBuild.once.Do(func() {
		agentBuild.dir, agentBuild.err = os.MkdirTemp("", "nexus-agent-bin-")
		if agentBuild.err != nil {
			return
		}
		agentBuild.bin = filepath.Join(agentBuild.dir, "agent")
		build := exec.Command("go", "build", "-o", agentBuild.bin, ".")
		build.Env = buildEnv
		agentBuild.out, agentBuild.err = build.CombinedOutput()
	})
	if agentBuild.err != nil {
		t.Fatalf("go build: %v\n%s", agentBuild.err, agentBuild.out)
	}
	return agentBuild.bin
}
