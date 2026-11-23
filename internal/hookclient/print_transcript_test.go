package hookclient

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

const printSession = "0123abcd-print-session"

func writePrintSession(t *testing.T, projects, text string) string {
	t.Helper()
	path := filepath.Join(projects, "-repo", printSession+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func printTranscriptText(t *testing.T, config, sessionID string) (string, bool) {
	t.Helper()
	t.Setenv("CLAUDE_CONFIG_DIR", config)
	file := newPrintTranscript(sessionID).open()
	if file == nil {
		return "", false
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(data), true
}

func printSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("no symlinks here: %v", err)
		}
		t.Fatal(err)
	}
}

func printTranscriptFollowsNoLink(t *testing.T, fileLink, dirLink func(t *testing.T, target, link string)) {
	t.Run("a linked config folder and projects folder are read", func(t *testing.T) {
		home := t.TempDir()
		writePrintSession(t, filepath.Join(home, "projects"), "home\n")
		config := filepath.Join(t.TempDir(), "claude")
		dirLink(t, home, config)
		if got, ok := printTranscriptText(t, config, printSession); !ok || got != "home\n" {
			t.Fatalf("through a linked config folder: %q %v", got, ok)
		}
		moved := t.TempDir()
		writePrintSession(t, moved, "moved\n")
		config = t.TempDir()
		dirLink(t, moved, filepath.Join(config, "projects"))
		if got, ok := printTranscriptText(t, config, printSession); !ok || got != "moved\n" {
			t.Fatalf("through a linked projects folder: %q %v", got, ok)
		}
	})

	t.Run("a linked project folder is not read", func(t *testing.T) {
		secret := writePrintSession(t, t.TempDir(), "secret\n")
		config := t.TempDir()
		if err := os.MkdirAll(filepath.Join(config, "projects"), 0o755); err != nil {
			t.Fatal(err)
		}
		dirLink(t, filepath.Dir(secret), filepath.Join(config, "projects", "-repo"))
		if got, ok := printTranscriptText(t, config, printSession); ok {
			t.Fatalf("read through a linked project folder: %q", got)
		}
	})

	t.Run("a linked session file is not read", func(t *testing.T) {
		secret := writePrintSession(t, t.TempDir(), "secret\n")
		config := t.TempDir()
		folder := filepath.Join(config, "projects", "-repo")
		if err := os.MkdirAll(folder, 0o755); err != nil {
			t.Fatal(err)
		}
		fileLink(t, secret, filepath.Join(folder, printSession+".jsonl"))
		if got, ok := printTranscriptText(t, config, printSession); ok {
			t.Fatalf("read through a linked session file: %q", got)
		}
	})
}

func TestPrintTranscriptFollowsNoLink(t *testing.T) {
	printTranscriptFollowsNoLink(t, printSymlink, printSymlink)
}

func TestPrintTranscriptTakesNoPathAsASessionID(t *testing.T) {
	config := t.TempDir()
	if err := os.WriteFile(filepath.Join(config, "secret.jsonl"), []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writePrintSession(t, filepath.Join(config, "projects"), "mine\n")
	for _, id := range []string{"../../secret", `..\..\secret`, "..", ""} {
		if got, ok := printTranscriptText(t, config, id); ok {
			t.Fatalf("session id %q read %q", id, got)
		}
	}
	if got, ok := printTranscriptText(t, config, printSession); !ok || got != "mine\n" {
		t.Fatalf("its own session was not read: %q %v", got, ok)
	}
}
