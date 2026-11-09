package chat

import (
	"os"
	"path/filepath"
	"testing"

	nexusfs "github.com/nexus-code/nexus-code/internal/fs"
)

// Without Developer Mode or an administrator, a profile's shared folder is a
// junction and a shared file a hard link: both are known as links, and only
// they go when no longer shared.
func TestJunctionsAndHardLinksAreKnownAsLinks(t *testing.T) {
	root := t.TempDir()
	def := filepath.Join(root, "default")
	own := filepath.Join(root, "own")
	for _, dir := range []string{filepath.Join(def, "skills"), own} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"config.toml", "AGENTS.md"} {
		if err := os.WriteFile(filepath.Join(def, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := nexusfs.Junction(filepath.Join(own, "skills"), filepath.Join(def, "skills")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(def, "config.toml"), filepath.Join(own, "config.toml")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(own, "AGENTS.md"), []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}

	for name, want := range map[string]bool{"skills": true, "config.toml": true, "AGENTS.md": false} {
		if got := linksTo(filepath.Join(own, name), filepath.Join(def, name)); got != want {
			t.Errorf("linksTo %s = %v, want %v", name, got, want)
		}
		if got := linkShared(filepath.Join(own, name), filepath.Join(def, name)); (got == linkMade) != want {
			t.Errorf("linkShared %s = %v", name, got)
		}
	}

	for _, name := range []string{"skills", "config.toml", "AGENTS.md"} {
		unlinkShared(filepath.Join(own, name), filepath.Join(def, name))
	}
	entries, err := os.ReadDir(own)
	if err != nil || len(entries) != 1 || entries[0].Name() != "AGENTS.md" {
		t.Fatalf("left in the profile's folder: %v %v", entries, err)
	}
	if b, err := os.ReadFile(filepath.Join(def, "config.toml")); err != nil || string(b) != "config.toml" {
		t.Fatalf("default config.toml reads %q %v", b, err)
	}
	if info, err := os.Stat(filepath.Join(def, "skills")); err != nil || !info.IsDir() {
		t.Fatalf("default skills: %v", err)
	}
}
