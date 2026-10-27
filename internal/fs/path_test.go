package fs

import (
	"path/filepath"
	"testing"
)

// Only a whole ".." path element escapes the root; names that merely start
// with two dots (..foo, Kubernetes' ..data) are ordinary workspace entries.
func TestResolveDotDotElement(t *testing.T) {
	root := t.TempDir()
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	for _, rel := range []string{"..foo", "..data/config", "a/../..foo", "...", "a/..b"} {
		abs, err := fsys.Resolve(rel)
		if err != nil {
			t.Fatalf("Resolve(%q): %v", rel, err)
		}
		if want := filepath.Join(fsys.root, rel); abs != want {
			t.Fatalf("Resolve(%q) = %q, want %q", rel, abs, want)
		}
	}
	for _, rel := range []string{"..", "../x", "a/../../x", "../" + filepath.Base(root) + "x"} {
		_, err := fsys.Resolve(rel)
		assertFSError(t, err, CodeOutOfWorkspace)
	}
}
