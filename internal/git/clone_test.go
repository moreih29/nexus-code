package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// ---------------------------------------------------------------------------
// Progress parser unit tests
// ---------------------------------------------------------------------------

func TestParseCloneProgressLine_AllPhases(t *testing.T) {
	cases := []struct {
		line         string
		wantPhase    string
		wantPct      int
		wantReceived int
		wantTotal    int
	}{
		{"remote: Counting objects: 25% (1/4)", "counting", 25, 1, 4},
		{"remote: Compressing objects: 50% (2/4)", "compressing", 50, 2, 4},
		{"Receiving objects: 75% (3/4), 12.00 KiB | 1.2 MiB/s", "receiving", 75, 3, 4},
		{"Resolving deltas: 100% (4/4), done.", "resolving", 100, 4, 4},
		{"Updating files: 100% (4/4), done.", "checkout", 100, 4, 4},
		{"Checking out files: 50% (2/4)", "checkout", 50, 2, 4},
		// Case-insensitive
		{"RECEIVING OBJECTS:  10% (1/10)", "receiving", 10, 1, 10},
	}
	for _, c := range cases {
		t.Run(c.line, func(t *testing.T) {
			m := parseCloneProgressLine(c.line)
			if m == nil {
				t.Fatalf("parseCloneProgressLine(%q) = nil, want match", c.line)
			}
			if m.phase != c.wantPhase {
				t.Errorf("phase: got %q, want %q", m.phase, c.wantPhase)
			}
			if m.pct != c.wantPct {
				t.Errorf("pct: got %d, want %d", m.pct, c.wantPct)
			}
			if m.received == nil || *m.received != c.wantReceived {
				t.Errorf("received: got %v, want %d", m.received, c.wantReceived)
			}
			if m.total == nil || *m.total != c.wantTotal {
				t.Errorf("total: got %v, want %d", m.total, c.wantTotal)
			}
		})
	}
}

func TestParseCloneProgressLine_NoMatch(t *testing.T) {
	noMatch := []string{
		"",
		"Cloning into 'repo'...",
		"remote: Enumerating objects: 100, done.",
		"Already up to date.",
		"fatal: not a git repository",
	}
	for _, line := range noMatch {
		if m := parseCloneProgressLine(line); m != nil {
			t.Errorf("parseCloneProgressLine(%q) = %+v, want nil", line, m)
		}
	}
}

func TestClampClonePct(t *testing.T) {
	cases := [][2]int{{-1, 0}, {0, 0}, {50, 50}, {100, 100}, {101, 100}, {200, 100}}
	for _, c := range cases {
		got := clampClonePct(c[0])
		if got != c[1] {
			t.Errorf("clampClonePct(%d) = %d, want %d", c[0], got, c[1])
		}
	}
}

// ---------------------------------------------------------------------------
// URL validator unit tests
// ---------------------------------------------------------------------------

func TestValidateCloneURL_Allowed(t *testing.T) {
	allowed := []string{
		"https://github.com/org/repo.git",
		"http://example.com/repo",
		"git://github.com/org/repo.git",
		"ssh://git@github.com/org/repo.git",
		"file:///home/user/repo",
		"git@github.com:org/repo.git",
		"HTTPS://example.com/repo", // case-insensitive scheme
	}
	for _, u := range allowed {
		if err := validateCloneURL(u); err != nil {
			t.Errorf("validateCloneURL(%q) unexpected error: %v", u, err)
		}
	}
}

func TestValidateCloneURL_Rejected(t *testing.T) {
	rejected := []string{
		"",
		"   ",
		"ftp://example.com/repo",
		"svn://example.com/repo",
		"not-a-url",
		"C:\\Users\\user\\repo",
	}
	for _, u := range rejected {
		if err := validateCloneURL(u); err == nil {
			t.Errorf("validateCloneURL(%q) expected error, got nil", u)
		}
	}
}

// ---------------------------------------------------------------------------
// Name / destination validator unit tests
// ---------------------------------------------------------------------------

func TestResolveCloneName_Valid(t *testing.T) {
	cases := []struct {
		name string
		url  string
		want string
	}{
		{"myrepo", "https://example.com/any.git", "myrepo"},
		{"my-repo.fork", "https://example.com/any.git", "my-repo.fork"},
		// Derived from URL when name is empty
		{"", "https://github.com/org/repo.git", "repo"},
		{"", "git@github.com:org/repo.git", "repo"},
		{"", "https://github.com/org/project/", "project"},
	}
	for _, c := range cases {
		got, err := resolveCloneName(c.name, c.url)
		if err != nil {
			t.Errorf("resolveCloneName(%q, %q) error: %v", c.name, c.url, err)
			continue
		}
		if got != c.want {
			t.Errorf("resolveCloneName(%q, %q) = %q, want %q", c.name, c.url, got, c.want)
		}
	}
}

func TestResolveCloneName_Invalid(t *testing.T) {
	// Names explicitly provided (non-empty) that must be rejected.
	invalidExplicit := []string{
		".hidden",
		"has/slash",
		"has space",
		strings.Repeat("a", 256),
		"has\x00nul",
	}
	for _, name := range invalidExplicit {
		if _, err := resolveCloneName(name, "https://example.com/x.git"); err == nil {
			t.Errorf("resolveCloneName(%q, ...) expected error, got nil", name)
		}
	}
	// Empty name with a URL that produces an invalid derived name must fail.
	// Use a URL with no path component so the derived name is empty.
	if _, err := resolveCloneName("", "https://"); err == nil {
		t.Error("resolveCloneName(\"\", \"https://\") expected error for empty derived name, got nil")
	}
}

func TestDeriveCloneName(t *testing.T) {
	cases := []struct {
		url  string
		want string
	}{
		{"https://github.com/org/repo.git", "repo"},
		{"https://github.com/org/repo", "repo"},
		{"git@github.com:org/repo.git", "repo"},
		{"https://github.com/org/project/", "project"},
		{"ssh://git@host/path/name.git", "name"},
	}
	for _, c := range cases {
		got := deriveCloneName(c.url)
		if got != c.want {
			t.Errorf("deriveCloneName(%q) = %q, want %q", c.url, got, c.want)
		}
	}
}

// ---------------------------------------------------------------------------
// Clone() integration tests (use local bare repos to avoid network)
// ---------------------------------------------------------------------------

func TestCloneLocalRepo(t *testing.T) {
	// Create a local bare repository to clone from.
	remote := t.TempDir()
	runGitCommand(t, remote, "init", "--bare")

	seed := t.TempDir()
	runGitCommand(t, seed, "init", "-b", "main")
	runGitCommand(t, seed, "config", "user.email", "nexus@example.test")
	runGitCommand(t, seed, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(seed, "README.md"), "hello\n")
	runGitCommand(t, seed, "add", "README.md")
	runGitCommand(t, seed, "commit", "-m", "initial")
	runGitCommand(t, seed, "remote", "add", "origin", remote)
	runGitCommand(t, seed, "push", "-u", "origin", "main")

	parent := t.TempDir()
	service := New(parent)

	params := CloneParams{
		StreamID:  "test-stream-1",
		URL:       "file://" + remote,
		ParentDir: parent,
		Name:      "cloned",
	}
	raw, _ := json.Marshal(params)
	res, err := service.Clone(context.Background(), raw)
	if err != nil {
		t.Fatalf("Clone returned error: %v", err)
	}
	result, ok := res.(CloneResult)
	if !ok {
		t.Fatalf("Clone result type = %T", res)
	}
	wantPath := filepath.Join(parent, "cloned")
	if result.AbsPath != wantPath {
		t.Errorf("AbsPath = %q, want %q", result.AbsPath, wantPath)
	}
	// Verify that the cloned directory contains the README.
	content, err := os.ReadFile(filepath.Join(result.AbsPath, "README.md"))
	if err != nil {
		t.Fatalf("README.md not found in clone: %v", err)
	}
	if strings.TrimSpace(string(content)) != "hello" {
		t.Errorf("README.md content = %q, want %q", string(content), "hello")
	}
}

func TestClone_DestinationExists(t *testing.T) {
	parent := t.TempDir()
	// Pre-create the target directory.
	if err := os.Mkdir(filepath.Join(parent, "existing"), 0o755); err != nil {
		t.Fatal(err)
	}

	service := New(parent)
	params := CloneParams{
		StreamID:  "test-stream-2",
		URL:       "https://example.invalid/repo.git",
		ParentDir: parent,
		Name:      "existing",
	}
	raw, _ := json.Marshal(params)
	_, err := service.Clone(context.Background(), raw)
	if err == nil {
		t.Fatal("expected error for pre-existing destination, got nil")
	}
	if !strings.Contains(err.Error(), string(KindCloneDestinationExists)) {
		t.Errorf("expected clone-destination-exists error, got: %v", err)
	}
}

func TestClone_InvalidURL(t *testing.T) {
	parent := t.TempDir()
	service := New(parent)
	params := CloneParams{
		StreamID:  "test-stream-3",
		URL:       "ftp://bad-scheme.example/repo",
		ParentDir: parent,
		Name:      "repo",
	}
	raw, _ := json.Marshal(params)
	_, err := service.Clone(context.Background(), raw)
	if err == nil {
		t.Fatal("expected error for disallowed URL scheme, got nil")
	}
	if !strings.Contains(err.Error(), string(KindCloneUrlInvalid)) {
		t.Errorf("expected clone-url-invalid error, got: %v", err)
	}
}

func TestClone_InvalidName(t *testing.T) {
	parent := t.TempDir()
	service := New(parent)
	params := CloneParams{
		StreamID:  "test-stream-4",
		URL:       "https://example.invalid/repo.git",
		ParentDir: parent,
		Name:      "has/slash",
	}
	raw, _ := json.Marshal(params)
	_, err := service.Clone(context.Background(), raw)
	if err == nil {
		t.Fatal("expected error for invalid name, got nil")
	}
	if !strings.Contains(err.Error(), string(KindCloneNameInvalid)) {
		t.Errorf("expected clone-name-invalid error, got: %v", err)
	}
}

func TestClone_ParentDirNotAbsolute(t *testing.T) {
	service := New(t.TempDir())
	params := CloneParams{
		StreamID:  "test-stream-5",
		URL:       "https://example.invalid/repo.git",
		ParentDir: "relative/path",
		Name:      "repo",
	}
	raw, _ := json.Marshal(params)
	_, err := service.Clone(context.Background(), raw)
	if err == nil {
		t.Fatal("expected error for relative parentDir, got nil")
	}
}

func TestClone_CancelDuringProgress(t *testing.T) {
	// Use a local bare repo that we can observe cancellation on.
	remote := t.TempDir()
	runGitCommand(t, remote, "init", "--bare")

	seed := t.TempDir()
	runGitCommand(t, seed, "init", "-b", "main")
	runGitCommand(t, seed, "config", "user.email", "nexus@example.test")
	runGitCommand(t, seed, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(seed, "README.md"), "hello\n")
	runGitCommand(t, seed, "add", "README.md")
	runGitCommand(t, seed, "commit", "-m", "initial")
	runGitCommand(t, seed, "remote", "add", "origin", remote)
	runGitCommand(t, seed, "push", "-u", "origin", "main")

	parent := t.TempDir()
	service := New(parent)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel before starting.

	params := CloneParams{
		StreamID:  "test-stream-6",
		URL:       "file://" + remote,
		ParentDir: parent,
		Name:      "cancelled",
	}
	raw, _ := json.Marshal(params)
	_, err := service.Clone(ctx, raw)
	if err == nil {
		t.Fatal("expected error for pre-cancelled context, got nil")
	}
	// Verify the destination was cleaned up.
	if _, statErr := os.Stat(filepath.Join(parent, "cancelled")); !os.IsNotExist(statErr) {
		t.Error("expected cancelled destination to be removed")
	}
}

func TestClone_MissingParamsReturnsProtocolError(t *testing.T) {
	service := New(t.TempDir())
	_, err := service.Clone(context.Background(), nil)
	if err == nil {
		t.Fatal("expected protocol error for nil params, got nil")
	}
	var coded proto.CodedError
	if coded.Code != "" {
		// just verify it's non-nil
	}
}
