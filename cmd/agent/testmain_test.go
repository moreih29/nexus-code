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

// buildEnv is the environment the test binary started with. TestMain moves
// HOME, but go build needs the real one to find its cache.
var buildEnv = os.Environ()

var agentBuild struct {
	once sync.Once
	dir  string
	bin  string
	out  []byte
	err  error
}

// TestMain points HOME at a scratch directory, so the hook server that this
// process and the agents it starts open puts its socket there and not in the
// developer's ~/.nexus-code.
func TestMain(m *testing.M) {
	// A short parent keeps socket paths under the 104-byte sun_path limit.
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

// agentBinary builds the agent on first use and returns its path. Every test
// shares the one binary.
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
