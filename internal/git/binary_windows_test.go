//go:build windows

package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Git installed with "Use Git from Git Bash only" is off PATH: the agent
// still finds it in its install location and runs it.
func TestServiceRunsGitOffPath(t *testing.T) {
	installed := ""
	for _, p := range gitInstallPaths("windows", os.Getenv) {
		if isRegularFile(p) {
			installed = p
			break
		}
	}
	if installed == "" {
		t.Skip("Git for Windows is not in its install location")
	}
	root := newRepo(t)
	t.Setenv("PATH", filepath.Join(os.Getenv("SystemRoot"), "System32"))

	service := New(root)
	info, err := service.Info(context.Background(), nil)
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if got, ok := info.(InfoResult); !ok || got.BinaryPath != installed {
		t.Fatalf("Info = %#v, want the git at %s", info, installed)
	}
	result, err := service.Detect(context.Background(), json.RawMessage(`{"cwd":"`+jsonEscapePath(root)+`"}`))
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if dr, ok := result.(DetectResult); !ok || dr.Kind != "repo" {
		t.Fatalf("Detect = %#v, want a repo", result)
	}
}
