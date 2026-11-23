package chat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func errorNamesNo(t *testing.T, err error, paths ...string) {
	t.Helper()
	if err == nil {
		t.Fatal("no error")
	}
	for _, path := range paths {
		if strings.Contains(err.Error(), path) || strings.Contains(err.Error(), filepath.ToSlash(path)) {
			t.Fatalf("the error names %s: %v", path, err)
		}
	}
}

func TestClaudeConfigErrorNamesNoPath(t *testing.T) {
	config := t.TempDir()
	if err := os.Mkdir(filepath.Join(config, ".claude.json"), 0o755); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(ClaudeConfigParams{ConfigDir: config})
	_, err := New().ClaudeConfig(context.Background(), raw)
	errorNamesNo(t, err, config)
}

func TestAttachErrorNamesNoPath(t *testing.T) {
	root := useAttachRoot(t)
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(root, []byte("not a folder"), 0o600); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(AttachParams{WorkspaceID: "ws", TabID: "t1", Name: "a.txt", Data: base64.StdEncoding.EncodeToString([]byte("x"))})
	_, err := New().Attach(context.Background(), raw)
	errorNamesNo(t, err, root)
}

func TestProfileDirErrorsNameTheFolderAsAsked(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	_, err := profileDirCall(t, ProfileDirParams{Agent: "claude", Dir: "~/.claude"})
	errorNamesNo(t, err, home)
	if !strings.Contains(err.Error(), "~/.claude") {
		t.Fatalf("the error does not name the folder asked for: %v", err)
	}

	if err := os.WriteFile(filepath.Join(home, "file"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = profileDirCall(t, ProfileDirParams{Agent: "claude", Dir: "~/file/profile"})
	errorNamesNo(t, err, home)
	if !strings.Contains(err.Error(), "~/file/profile") {
		t.Fatalf("the error does not name the folder asked for: %v", err)
	}
}
