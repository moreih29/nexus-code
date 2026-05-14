package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// git.info tests
// ---------------------------------------------------------------------------

func TestServiceInfo_ReturnsResult(t *testing.T) {
	root := t.TempDir()
	service := New(root)

	result, err := service.Info(context.Background(), json.RawMessage("{}"))
	if err != nil {
		t.Fatalf("Info returned unexpected error: %v", err)
	}
	if result == nil {
		// git may not be available in the test environment; skip rather than fail.
		t.Skip("git binary not found in test environment")
	}

	info, ok := result.(InfoResult)
	if !ok {
		t.Fatalf("Info returned unexpected type: %T", result)
	}
	if info.BinaryPath == "" {
		t.Error("expected non-empty binaryPath")
	}
	if info.BinaryVersion == "" {
		t.Error("expected non-empty binaryVersion")
	}
	// version should look like "2.39.0" or similar.
	if !strings.Contains(info.BinaryVersion, ".") {
		t.Errorf("unexpected binaryVersion format: %q", info.BinaryVersion)
	}
}

func TestParseGitVersionOutput_Valid(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"git version 2.39.0\n", "2.39.0"},
		{"git version 2.41.0.windows.3\n", "2.41.0.windows.3"},
		{"GIT VERSION 2.40.1\n", "2.40.1"},
		{"git version 2.42.0 (Apple Git-100)\n", "2.42.0 (Apple Git-100)"},
	}
	for _, c := range cases {
		t.Run(c.input, func(t *testing.T) {
			got := parseGitVersionOutput(c.input)
			if got != c.want {
				t.Errorf("parseGitVersionOutput(%q) = %q, want %q", c.input, got, c.want)
			}
		})
	}
}

func TestParseGitVersionOutput_Invalid(t *testing.T) {
	cases := []string{
		"",
		"not git output",
		"git: command not found",
	}
	for _, c := range cases {
		t.Run(c, func(t *testing.T) {
			got := parseGitVersionOutput(c)
			if got != "" {
				t.Errorf("parseGitVersionOutput(%q) = %q, want empty string", c, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// git.detect tests
// ---------------------------------------------------------------------------

func TestServiceDetect_Repo(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")

	service := New(root)
	params := `{"cwd":"` + jsonEscapePath(root) + `"}`
	result, err := service.Detect(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("Detect returned error: %v", err)
	}

	dr, ok := result.(DetectResult)
	if !ok {
		t.Fatalf("expected DetectResult, got %T", result)
	}
	if dr.Kind != "repo" {
		t.Errorf("expected kind=repo, got %q", dr.Kind)
	}
	if dr.TopLevel == "" {
		t.Error("expected non-empty topLevel")
	}
	if dr.GitDir == "" {
		t.Error("expected non-empty gitDir")
	}
	// .git directory should be inside root.
	if !strings.HasPrefix(dr.GitDir, root) {
		t.Errorf("gitDir %q not inside root %q", dr.GitDir, root)
	}
}

func TestServiceDetect_NonRepo(t *testing.T) {
	root := t.TempDir()
	// root is not a git repo.

	service := New(root)
	params := `{"cwd":"` + jsonEscapePath(root) + `"}`
	result, err := service.Detect(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("Detect returned error: %v", err)
	}

	dr, ok := result.(DetectResult)
	if !ok {
		t.Fatalf("expected DetectResult, got %T", result)
	}
	if dr.Kind != "non-repo" {
		t.Errorf("expected kind=non-repo, got %q", dr.Kind)
	}
}

func TestServiceDetect_Subdir(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")

	// Create a subdirectory inside the repo.
	subdir := filepath.Join(root, "src", "components")
	writeDir(t, subdir)

	service := New(root)
	params := `{"cwd":"` + jsonEscapePath(subdir) + `"}`
	result, err := service.Detect(context.Background(), json.RawMessage(params))
	if err != nil {
		t.Fatalf("Detect from subdir returned error: %v", err)
	}

	dr, ok := result.(DetectResult)
	if !ok {
		t.Fatalf("expected DetectResult, got %T", result)
	}
	if dr.Kind != "repo" {
		t.Errorf("expected kind=repo from subdir, got %q", dr.Kind)
	}
	// TopLevel should be the repo root, not the subdir. Use EvalSymlinks to
	// handle macOS which resolves /var -> /private/var in TempDir.
	wantTopLevel, _ := filepath.EvalSymlinks(root)
	gotTopLevel, _ := filepath.EvalSymlinks(dr.TopLevel)
	if filepath.Clean(gotTopLevel) != filepath.Clean(wantTopLevel) {
		t.Errorf("topLevel %q != root %q", dr.TopLevel, root)
	}
}

func TestServiceDetect_MissingCwd(t *testing.T) {
	root := t.TempDir()
	service := New(root)

	_, err := service.Detect(context.Background(), json.RawMessage(`{}`))
	if err == nil {
		t.Error("expected error for missing cwd param, got nil")
	}
}

func TestParseRevParseLines(t *testing.T) {
	cases := []struct {
		input string
		want  []string
	}{
		{"/repo\n.git\n", []string{"/repo", ".git"}},
		{"/repo\r\n.git\r\n", []string{"/repo", ".git"}},
		{"/repo\n.git", []string{"/repo", ".git"}},
	}
	for _, c := range cases {
		t.Run(c.input, func(t *testing.T) {
			got := parseRevParseLines(c.input)
			if len(got) != len(c.want) {
				t.Errorf("len %d, want %d; got %v", len(got), len(c.want), got)
				return
			}
			for i := range c.want {
				if got[i] != c.want[i] {
					t.Errorf("line[%d] = %q, want %q", i, got[i], c.want[i])
				}
			}
		})
	}
}

// jsonEscapePath escapes backslashes in Windows paths for JSON embedding.
func jsonEscapePath(p string) string {
	return strings.ReplaceAll(p, `\`, `\\`)
}

// writeDir creates a directory (and all parents) for use in tests.
func writeDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("writeDir(%q): %v", dir, err)
	}
}
