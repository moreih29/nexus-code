//go:build darwin || linux || windows

package fs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestProtectedReadsRejectReplacedPathComponents(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "note.txt")
	putPreviewFile(t, file, "inside")
	secret := filepath.Join(outside, "note.txt")
	putPreviewFile(t, secret, "outside")
	ctx := context.Background()
	args := json.RawMessage(`{"relPath":"note.txt"}`)
	if got, err := s.ReadFileNoLinks(ctx, args); err != nil || got.(ReadFileResult).Content != "inside" {
		t.Fatalf("could not read regular file: %+v, %v", got, err)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, file); err != nil {
		t.Skipf("cannot create symlinks: %v", err)
	}
	if _, err := s.ReadFileNoLinks(ctx, args); err == nil {
		t.Fatal("read through a replaced file link")
	}
	alias := filepath.Join(root, "folder")
	if err := os.Symlink(outside, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadRangeNoLinks(ctx, json.RawMessage(`{"relPath":"folder/note.txt","offset":0,"length":8}`)); err == nil {
		t.Fatal("read through a replaced directory link")
	}
	if _, err := s.ReaddirNoLinks(ctx, json.RawMessage(`{"relPath":"folder"}`)); err == nil {
		t.Fatal("listed through a replaced directory link")
	}
	if _, err := s.ReaddirNoLinks(ctx, json.RawMessage(`{"relPath":"."}`)); err != nil {
		t.Fatalf("listing the workspace root failed: %v", err)
	}
}
