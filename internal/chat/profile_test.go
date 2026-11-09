package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func profileDirCall(t *testing.T, params ProfileDirParams) (ProfileDirResult, error) {
	t.Helper()
	raw, _ := json.Marshal(params)
	got, err := New().ProfileDir(context.Background(), raw)
	if err != nil {
		return ProfileDirResult{}, err
	}
	return got.(ProfileDirResult), nil
}

func TestProfileDirMakesTheFolderAndLinksWhatItShares(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	saved := loginEnv
	loginEnv = func() map[string]string { return nil }
	t.Cleanup(func() { loginEnv = saved })

	def := filepath.Join(home, ".claude")
	if err := os.MkdirAll(filepath.Join(def, "skills"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(def, "CLAUDE.md"), []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := profileDirCall(t, ProfileDirParams{
		Agent:     "claude",
		Dir:       "~/.claude-personal",
		Shared:    []string{"CLAUDE.md", "skills", "agents"},
		Shareable: []string{"CLAUDE.md", "settings.json", "skills", "agents"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, ".claude-personal")
	if got.Dir != want || got.DefaultDir != def {
		t.Fatalf("dir %q default %q, want %q %q", got.Dir, got.DefaultDir, want, def)
	}
	// agents/ is not in the default folder: nothing to link.
	if len(got.Linked) != 2 || got.Linked[0] != "CLAUDE.md" || got.Linked[1] != "skills" {
		t.Fatalf("linked %v", got.Linked)
	}
	// Windows: a junction and, short of the rights a symbolic link needs, a
	// hard link.
	for _, name := range []string{"CLAUDE.md", "skills"} {
		if !linksTo(filepath.Join(want, name), filepath.Join(def, name)) {
			t.Fatalf("%s is not linked to the default folder's", name)
		}
	}
	if b, err := os.ReadFile(filepath.Join(want, "CLAUDE.md")); err != nil || string(b) != "hi" {
		t.Fatalf("CLAUDE.md reads %q %v", b, err)
	}
	// Linked before: taken as linked again, not as the folder's own.
	again, err := profileDirCall(t, ProfileDirParams{
		Agent:     "claude",
		Dir:       "~/.claude-personal",
		Shared:    []string{"CLAUDE.md", "skills", "agents"},
		Shareable: []string{"CLAUDE.md", "settings.json", "skills", "agents"},
	})
	if err != nil || len(again.Linked) != 2 || len(again.Failed) != 0 {
		t.Fatalf("again linked %v failed %v: %v", again.Linked, again.Failed, err)
	}

	// No longer shared: the link goes; a file of the folder's own stays.
	if err := os.WriteFile(filepath.Join(want, "settings.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := profileDirCall(t, ProfileDirParams{
		Agent:     "claude",
		Dir:       "~/.claude-personal",
		Shared:    []string{"CLAUDE.md"},
		Shareable: []string{"CLAUDE.md", "settings.json", "skills", "agents"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(want, "skills")); !os.IsNotExist(err) {
		t.Fatalf("skills link still there: %v", err)
	}
	if _, err := os.Stat(filepath.Join(want, "settings.json")); err != nil {
		t.Fatalf("own settings.json gone: %v", err)
	}
	// The default folder keeps what was unlinked.
	if _, err := os.Stat(filepath.Join(def, "skills")); err != nil {
		t.Fatalf("default skills gone: %v", err)
	}

	// Unshared too: the file's link goes, and the default's file stays.
	if _, err := profileDirCall(t, ProfileDirParams{
		Agent:     "claude",
		Dir:       "~/.claude-personal",
		Shareable: []string{"CLAUDE.md", "settings.json", "skills", "agents"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(want, "CLAUDE.md")); !os.IsNotExist(err) {
		t.Fatalf("CLAUDE.md link still there: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(def, "CLAUDE.md")); err != nil || string(b) != "hi" {
		t.Fatalf("default CLAUDE.md reads %q %v", b, err)
	}
}

func TestProfileFoldersPickedOnWindowsReadOnEveryHost(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	want := filepath.Join(home, ".claude-work", "main")
	for _, dir := range []string{`~\.claude-work\main`, "~/.claude-work/main"} {
		if got := expandProfileDir(dir, home); got != want {
			t.Errorf("expandProfileDir(%q) = %q, want %q", dir, got, want)
		}
		// The readers of sessions, transcripts and settings take it alike.
		if got := configDir(dir); got != want {
			t.Errorf("configDir(%q) = %q, want %q", dir, got, want)
		}
	}
}

func TestProfileDirRefusesTheDefaultFolderAndRelativePaths(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CODEX_HOME", "")
	saved := loginEnv
	loginEnv = func() map[string]string { return nil }
	t.Cleanup(func() { loginEnv = saved })

	if _, err := profileDirCall(t, ProfileDirParams{Agent: "codex", Dir: "~/.codex"}); err == nil {
		t.Fatal("the default folder was taken as a profile's")
	}
	if _, err := profileDirCall(t, ProfileDirParams{Agent: "codex", Dir: "relative/dir"}); err == nil {
		t.Fatal("a relative folder was taken")
	}
	if _, err := profileDirCall(t, ProfileDirParams{Agent: "gemini", Dir: "~/.x"}); err == nil {
		t.Fatal("an unknown agent was taken")
	}
	got, err := profileDirCall(t, ProfileDirParams{Agent: "codex", Dir: "~/.codex-2"})
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(got.Dir); err != nil || !info.IsDir() {
		t.Fatalf("folder not made: %v", err)
	}
}
