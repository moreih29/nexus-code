package fs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type cancelCopyAfterWrite struct {
	context.Context
	path   string
	cancel context.CancelFunc
}

func (c cancelCopyAfterWrite) Err() error {
	if stat, err := os.Stat(c.path); err == nil && stat.Size() > 0 {
		c.cancel()
	}
	return c.Context.Err()
}

func TestCopyCancellationRollsBackPartialDirectory(t *testing.T) {
	for _, name := range []string{"new directory", "overwrite"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			must(t, os.MkdirAll(filepath.Join(root, "src", "sub"), 0o755))
			must(t, os.WriteFile(filepath.Join(root, "src", "sub", "file"), []byte(strings.Repeat("a", 96<<10)), 0o644))
			dst := filepath.Join(root, "dst")
			overwrite := name == "overwrite"
			if overwrite {
				must(t, os.Mkdir(dst, 0o755))
				must(t, os.WriteFile(filepath.Join(dst, "original"), []byte("original contents"), 0o644))
			}
			partial := filepath.Join(dst, "sub", "file")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			_, err := mustFS(t, root).CopyFile(cancelCopyAfterWrite{ctx, partial, cancel}, mustJSON(t, CopyFileParams{
				FromRelPath: "src",
				ToRelPath:   "dst",
				Overwrite:   overwrite,
			}))
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("copy returned %v, want cancellation after first write", err)
			}
			if _, err := os.Stat(partial); !os.IsNotExist(err) {
				t.Fatalf("partial copy remains: %v", err)
			}
			if overwrite {
				original, err := os.ReadFile(filepath.Join(dst, "original"))
				if err != nil || string(original) != "original contents" {
					t.Fatalf("overwrite lost original: %q, %v", original, err)
				}
			} else if _, err := os.Stat(dst); !os.IsNotExist(err) {
				t.Fatalf("partial destination remains: %v", err)
			}
			assertNoTmpResidue(t, root)
		})
	}
}
