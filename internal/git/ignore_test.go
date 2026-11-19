package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestAddToGitignorePreservesMode guards replacements of private ignore files.
func TestAddToGitignorePreservesMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows only represents the owner write bit through chmod")
	}
	root := t.TempDir()
	path := filepath.Join(root, ".gitignore")
	if err := os.WriteFile(path, []byte("existing.log\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := New(root).AddToGitignore(context.Background(), json.RawMessage(`{"relPath":"new.log"}`))
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("replacement mode is %o, want 600", got)
	}
	if content := readFile(t, path); !strings.Contains(content, "existing.log\nnew.log\n") {
		t.Fatalf("unexpected ignore content %q", content)
	}
}
