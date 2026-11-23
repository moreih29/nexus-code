package fs

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

func TestWriteFile_ExistingMatch_OK(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "a.txt")
	must(t, os.WriteFile(path, []byte("v1"), 0o644))
	info, err := os.Lstat(path)
	must(t, err)

	res := callWrite(t, mustFS(t, root), map[string]any{
		"relPath": "a.txt",
		"content": "v2",
		"expected": map[string]any{
			"exists": true,
			"mtime":  formatMTime(info.ModTime()),
			"size":   info.Size(),
		},
	})
	if res.Kind != "ok" {
		t.Fatalf("expected ok, got %q (actual=%+v)", res.Kind, res.Actual)
	}
}

func TestWriteFile_ExpectedFalse_ButExists_Conflict(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("v1"), 0o644))

	res := callWrite(t, mustFS(t, root), map[string]any{
		"relPath":  "a.txt",
		"content":  "v2",
		"expected": map[string]any{"exists": false},
	})
	if res.Kind != "conflict" {
		t.Fatalf("expected conflict, got %q", res.Kind)
	}
	if res.Actual == nil || !res.Actual.Exists || res.Actual.MTime == nil || res.Actual.Size == nil {
		t.Fatalf("conflict.actual incomplete: %+v", res.Actual)
	}
}

func TestWriteFile_ExpectedTrue_ButMissing_Conflict(t *testing.T) {
	root := t.TempDir()
	mt := "2020-01-01T00:00:00.000Z"
	sz := int64(2)
	res := callWrite(t, mustFS(t, root), map[string]any{
		"relPath": "ghost.txt",
		"content": "v2",
		"expected": map[string]any{
			"exists": true,
			"mtime":  mt,
			"size":   sz,
		},
	})
	if res.Kind != "conflict" {
		t.Fatalf("expected conflict, got %q", res.Kind)
	}
	if res.Actual == nil || res.Actual.Exists {
		t.Fatalf("expected actual.exists=false, got %+v", res.Actual)
	}
	if _, err := os.Stat(filepath.Join(root, "ghost.txt")); !os.IsNotExist(err) {
		t.Fatalf("conflict path should not create file: %v", err)
	}
}

func TestWriteFile_Directory_Refused(t *testing.T) {
	root := t.TempDir()
	must(t, os.Mkdir(filepath.Join(root, "d"), 0o755))

	_, err := mustFS(t, root).WriteFile(context.Background(), mustJSON(t, map[string]any{
		"relPath": "d",
		"content": "x",
	}))
	if err == nil {
		t.Fatal("expected error")
	}
	if fsErr, ok := err.(FSError); !ok || fsErr.Code != CodeIsDirectory {
		t.Fatalf("expected IS_DIRECTORY, got %v", err)
	}
}

func TestWriteFile_OutOfWorkspace_Refused(t *testing.T) {
	root := t.TempDir()
	_, err := mustFS(t, root).WriteFile(context.Background(), mustJSON(t, map[string]any{
		"relPath": "../escape.txt",
		"content": "x",
	}))
	if err == nil {
		t.Fatal("expected error")
	}
	if fsErr, ok := err.(FSError); !ok || fsErr.Code != CodeOutOfWorkspace {
		t.Fatalf("expected OUT_OF_WORKSPACE, got %v", err)
	}
}

func TestWriteFile_AtomicNoTmpResidue(t *testing.T) {
	root := t.TempDir()
	res := callWrite(t, mustFS(t, root), map[string]any{
		"relPath":  "x.txt",
		"content":  "hi",
		"expected": map[string]any{"exists": false},
	})
	if res.Kind != "ok" {
		t.Fatalf("write failed: %+v", res)
	}
	entries, err := os.ReadDir(root)
	must(t, err)
	if len(entries) != 1 || entries[0].Name() != "x.txt" {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("expected only x.txt in root, got %v", names)
	}
}

func TestCreateFileAlreadyExists(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "taken.txt"), []byte("x"), 0o644))

	_, err := mustFS(t, root).CreateFile(context.Background(), mustJSON(t, map[string]any{
		"relPath": "taken.txt",
	}))
	if err == nil {
		t.Fatal("expected error")
	}
	if fsErr, ok := err.(FSError); !ok || fsErr.Code != CodeAlreadyExists {
		t.Fatalf("expected ALREADY_EXISTS, got %v", err)
	}
}

func TestUnlinkSymlinkRemovesLinkOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink permissions vary on Windows")
	}
	root := t.TempDir()
	target := filepath.Join(root, "target.txt")
	link := filepath.Join(root, "link.txt")
	must(t, os.WriteFile(target, []byte("target"), 0o644))
	must(t, os.Symlink(target, link))

	_, err := mustFS(t, root).Unlink(context.Background(), mustJSON(t, map[string]any{
		"relPath": "link.txt",
	}))
	must(t, err)
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("expected symlink entry removed, got err=%v", err)
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "target" {
		t.Fatalf("symlink target changed: bytes=%q err=%v", got, err)
	}
}

func TestUnlinkDirectoryRejects(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "dir")
	must(t, os.Mkdir(dir, 0o755))

	_, err := mustFS(t, root).Unlink(context.Background(), mustJSON(t, map[string]any{
		"relPath": "dir",
	}))
	assertFSError(t, err, CodeIsDirectory)
	if info, statErr := os.Lstat(dir); statErr != nil || !info.IsDir() {
		t.Fatalf("directory should remain after rejected unlink: info=%v err=%v", info, statErr)
	}
}

func TestRmdirNonEmptyRejects(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "full")
	must(t, os.Mkdir(dir, 0o755))
	must(t, os.WriteFile(filepath.Join(dir, "child.txt"), []byte("x"), 0o644))

	_, err := mustFS(t, root).Rmdir(context.Background(), mustJSON(t, map[string]any{
		"relPath": "full",
	}))
	assertFSError(t, err, CodeNotEmpty)
	if _, statErr := os.Lstat(filepath.Join(dir, "child.txt")); statErr != nil {
		t.Fatalf("non-empty directory contents should remain: %v", statErr)
	}
}

func TestRmdirFileRejects(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file.txt")
	must(t, os.WriteFile(file, []byte("payload"), 0o644))

	_, err := mustFS(t, root).Rmdir(context.Background(), mustJSON(t, map[string]any{
		"relPath": "file.txt",
	}))
	assertFSError(t, err, CodeNotDirectory)
	if got, readErr := os.ReadFile(file); readErr != nil || string(got) != "payload" {
		t.Fatalf("file should remain after rejected rmdir: bytes=%q err=%v", got, readErr)
	}
}

func TestRmdirSymlinkRejectsAndPreservesTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink permissions vary on Windows")
	}
	root := t.TempDir()
	targetDir := filepath.Join(root, "target-dir")
	linkDir := filepath.Join(root, "link-dir")
	must(t, os.Mkdir(targetDir, 0o755))
	must(t, os.Symlink(targetDir, linkDir))

	_, err := mustFS(t, root).Rmdir(context.Background(), mustJSON(t, map[string]any{
		"relPath": "link-dir",
	}))
	assertFSError(t, err, CodeNotDirectory)
	if info, statErr := os.Lstat(linkDir); statErr != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("symlink should remain after rejected rmdir: info=%v err=%v", info, statErr)
	}
	if info, statErr := os.Lstat(targetDir); statErr != nil || !info.IsDir() {
		t.Fatalf("symlink target dir should remain after rejected rmdir: info=%v err=%v", info, statErr)
	}
}

func TestRenameCrossDeviceMapsEXDEV(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "old.txt"), []byte("payload"), 0o644))
	orig := renamePath
	renamePath = func(oldpath, newpath string) error {
		return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: errCrossDevice}
	}
	t.Cleanup(func() { renamePath = orig })

	_, err := mustFS(t, root).Rename(context.Background(), mustJSON(t, map[string]any{
		"fromRelPath": "old.txt",
		"toRelPath":   "new.txt",
	}))
	assertFSError(t, err, CodeCrossDevice)
}

func TestRenameTargetExistsRejects(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "old.txt"), []byte("old"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "taken.txt"), []byte("taken"), 0o644))
	orig := renamePath
	renamePath = func(oldpath, newpath string) error {
		t.Fatalf("renamePath should not be called when target exists: %s -> %s", oldpath, newpath)
		return nil
	}
	t.Cleanup(func() { renamePath = orig })

	_, err := mustFS(t, root).Rename(context.Background(), mustJSON(t, map[string]any{
		"fromRelPath": "old.txt",
		"toRelPath":   "taken.txt",
	}))
	assertFSError(t, err, CodeAlreadyExists)
	if got, readErr := os.ReadFile(filepath.Join(root, "taken.txt")); readErr != nil || string(got) != "taken" {
		t.Fatalf("target should remain unchanged: bytes=%q err=%v", got, readErr)
	}
}

func TestRenameOverwriteReplacesExisting(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "src.txt"), []byte("new"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "dst.txt"), []byte("old"), 0o644))

	dispatchOK(t, mustFS(t, root), "fs.rename", map[string]any{
		"fromRelPath": "src.txt",
		"toRelPath":   "dst.txt",
		"overwrite":   true,
	})

	if got, err := os.ReadFile(filepath.Join(root, "dst.txt")); err != nil || string(got) != "new" {
		t.Fatalf("destination should be replaced: bytes=%q err=%v", got, err)
	}
	if _, err := os.Lstat(filepath.Join(root, "src.txt")); !os.IsNotExist(err) {
		t.Fatalf("source should be gone after rename, err=%v", err)
	}
}

func TestRenameOverwriteReplacesNonEmptyDir(t *testing.T) {
	root := t.TempDir()
	srcDir := filepath.Join(root, "src-dir")
	must(t, os.Mkdir(srcDir, 0o755))
	must(t, os.WriteFile(filepath.Join(srcDir, "keep.txt"), []byte("keep"), 0o644))
	dstDir := filepath.Join(root, "dst-dir")
	must(t, os.Mkdir(dstDir, 0o755))
	must(t, os.WriteFile(filepath.Join(dstDir, "stale.txt"), []byte("stale"), 0o644))

	dispatchOK(t, mustFS(t, root), "fs.rename", map[string]any{
		"fromRelPath": "src-dir",
		"toRelPath":   "dst-dir",
		"overwrite":   true,
	})

	if got, err := os.ReadFile(filepath.Join(dstDir, "keep.txt")); err != nil || string(got) != "keep" {
		t.Fatalf("moved file missing after overwrite: bytes=%q err=%v", got, err)
	}
	if _, err := os.Lstat(filepath.Join(dstDir, "stale.txt")); !os.IsNotExist(err) {
		t.Fatalf("stale file should be removed, err=%v", err)
	}
	if _, err := os.Lstat(srcDir); !os.IsNotExist(err) {
		t.Fatalf("source dir should be gone after rename, err=%v", err)
	}
}

func TestRenameOverwriteKeepsDestinationOnFailure(t *testing.T) {
	for _, tc := range []struct {
		name  string
		from  string
		exdev bool
		code  string
	}{
		{name: "missing-source", from: "src/x", code: CodeNotFound},
		{name: "cross-device", from: "src.txt", exdev: true, code: CodeCrossDevice},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			must(t, os.WriteFile(filepath.Join(root, "src.txt"), []byte("new"), 0o644))
			must(t, os.MkdirAll(filepath.Join(root, "dst", "x"), 0o755))
			must(t, os.WriteFile(filepath.Join(root, "dst", "x", "important.txt"), []byte("keep"), 0o644))
			if tc.exdev {
				orig := renamePath
				renamePath = func(oldpath, newpath string) error {
					return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: errCrossDevice}
				}
				t.Cleanup(func() { renamePath = orig })
			}

			_, err := mustFS(t, root).Rename(context.Background(), mustJSON(t, map[string]any{
				"fromRelPath": tc.from,
				"toRelPath":   "dst/x",
				"overwrite":   true,
			}))
			assertFSError(t, err, tc.code)
			if got, readErr := os.ReadFile(filepath.Join(root, "dst", "x", "important.txt")); readErr != nil || string(got) != "keep" {
				t.Fatalf("destination lost by failed rename: bytes=%q err=%v", got, readErr)
			}
			assertNoTmpResidue(t, filepath.Join(root, "dst"))
		})
	}
}

func TestRenameCaseOnly(t *testing.T) {
	for _, overwrite := range []bool{false, true} {
		t.Run(fmt.Sprintf("overwrite=%v", overwrite), func(t *testing.T) {
			root := t.TempDir()
			must(t, os.WriteFile(filepath.Join(root, "Foo.txt"), []byte("payload"), 0o644))
			if _, err := os.Lstat(filepath.Join(root, "foo.txt")); err != nil {
				t.Skip("case-sensitive filesystem")
			}

			dispatchOK(t, mustFS(t, root), "fs.rename", map[string]any{
				"fromRelPath": "Foo.txt",
				"toRelPath":   "foo.txt",
				"overwrite":   overwrite,
			})
			entries, err := os.ReadDir(root)
			must(t, err)
			if len(entries) != 1 || entries[0].Name() != "foo.txt" {
				t.Fatalf("entries after case-only rename = %v", entries)
			}
			if got, err := os.ReadFile(filepath.Join(root, "foo.txt")); err != nil || string(got) != "payload" {
				t.Fatalf("renamed file mismatch: bytes=%q err=%v", got, err)
			}
		})
	}
}

func TestRenameOntoHardLinkStillRefused(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("payload"), 0o644))
	if err := os.Link(filepath.Join(root, "a.txt"), filepath.Join(root, "b.txt")); err != nil {
		t.Skipf("hard links unsupported: %v", err)
	}

	_, err := mustFS(t, root).Rename(context.Background(), mustJSON(t, map[string]any{
		"fromRelPath": "a.txt",
		"toRelPath":   "b.txt",
	}))
	assertFSError(t, err, CodeAlreadyExists)
}

func assertNoTmpResidue(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	must(t, err)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), tmpPrefix) {
			t.Fatalf("left %s behind in %s", entry.Name(), dir)
		}
	}
}

func TestRenameOutOfWorkspaceRejects(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "old.txt"), []byte("old"), 0o644))

	_, err := mustFS(t, root).Rename(context.Background(), mustJSON(t, map[string]any{
		"fromRelPath": "old.txt",
		"toRelPath":   "../escape.txt",
	}))
	assertFSError(t, err, CodeOutOfWorkspace)
	if _, statErr := os.Lstat(filepath.Join(root, "old.txt")); statErr != nil {
		t.Fatalf("source should remain after rejected rename: %v", statErr)
	}
}

func TestCopyFileTargetAlreadyExists(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "src.txt"), []byte("src"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "dst.txt"), []byte("dst"), 0o644))

	_, err := mustFS(t, root).CopyFile(context.Background(), mustJSON(t, map[string]any{
		"fromRelPath": "src.txt",
		"toRelPath":   "dst.txt",
	}))
	assertFSError(t, err, CodeAlreadyExists)
	if got, readErr := os.ReadFile(filepath.Join(root, "dst.txt")); readErr != nil || string(got) != "dst" {
		t.Fatalf("target should remain unchanged: bytes=%q err=%v", got, readErr)
	}
}

func TestCopyFileOverwriteReplacesExisting(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "src.txt"), []byte("new"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "dst.txt"), []byte("old"), 0o644))

	dispatchOK(t, mustFS(t, root), "fs.copyFile", map[string]any{
		"fromRelPath": "src.txt",
		"toRelPath":   "dst.txt",
		"overwrite":   true,
	})

	if got, err := os.ReadFile(filepath.Join(root, "dst.txt")); err != nil || string(got) != "new" {
		t.Fatalf("destination should be replaced: bytes=%q err=%v", got, err)
	}
}

func TestCopyFileOverwriteReplacesNonEmptyDir(t *testing.T) {
	root := t.TempDir()
	srcDir := filepath.Join(root, "src-dir")
	must(t, os.Mkdir(srcDir, 0o755))
	must(t, os.WriteFile(filepath.Join(srcDir, "keep.txt"), []byte("keep"), 0o644))

	dstDir := filepath.Join(root, "dst-dir")
	must(t, os.Mkdir(dstDir, 0o755))
	must(t, os.WriteFile(filepath.Join(dstDir, "stale.txt"), []byte("stale"), 0o644))

	dispatchOK(t, mustFS(t, root), "fs.copyFile", map[string]any{
		"fromRelPath": "src-dir",
		"toRelPath":   "dst-dir",
		"overwrite":   true,
	})

	if got, err := os.ReadFile(filepath.Join(dstDir, "keep.txt")); err != nil || string(got) != "keep" {
		t.Fatalf("copied file missing after overwrite: bytes=%q err=%v", got, err)
	}
	if _, err := os.Lstat(filepath.Join(dstDir, "stale.txt")); !os.IsNotExist(err) {
		t.Fatalf("stale file should be removed by overwrite, err=%v", err)
	}
	assertNoTmpResidue(t, root)
}

func TestCopyFileOverwriteKeepsDestinationOnFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows ignores the mode bits that make the source unreadable")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores the unreadable file this test relies on")
	}
	root := t.TempDir()
	srcDir := filepath.Join(root, "src-dir")
	must(t, os.Mkdir(srcDir, 0o755))
	must(t, os.WriteFile(filepath.Join(srcDir, "a.txt"), []byte("a"), 0o644))
	must(t, os.WriteFile(filepath.Join(srcDir, "unreadable.txt"), []byte("x"), 0o000))
	dstDir := filepath.Join(root, "dst-dir")
	must(t, os.Mkdir(dstDir, 0o755))
	must(t, os.WriteFile(filepath.Join(dstDir, "important.txt"), []byte("keep"), 0o644))

	_, err := mustFS(t, root).CopyFile(context.Background(), mustJSON(t, map[string]any{
		"fromRelPath": "src-dir",
		"toRelPath":   "dst-dir",
		"overwrite":   true,
	}))
	assertFSError(t, err, CodePermissionDenied)
	if got, readErr := os.ReadFile(filepath.Join(dstDir, "important.txt")); readErr != nil || string(got) != "keep" {
		t.Fatalf("destination lost by failed copy: bytes=%q err=%v", got, readErr)
	}
	if _, statErr := os.Lstat(filepath.Join(dstDir, "a.txt")); !os.IsNotExist(statErr) {
		t.Fatalf("partial copy left in destination, err=%v", statErr)
	}
	assertNoTmpResidue(t, root)
}

func TestCopyFileLeavesNothingOnFailure(t *testing.T) {
	root := t.TempDir()
	srcDir := filepath.Join(root, "src-dir")
	must(t, os.Mkdir(srcDir, 0o755))
	must(t, os.WriteFile(filepath.Join(srcDir, "a.txt"), []byte("a"), 0o644))
	makeUnreadable(t, filepath.Join(srcDir, "unreadable.txt"))

	_, err := mustFS(t, root).CopyFile(context.Background(), mustJSON(t, map[string]any{
		"fromRelPath": "src-dir",
		"toRelPath":   "dst-dir",
	}))
	if err == nil {
		t.Fatal("copying an unreadable file succeeded")
	}
	if _, statErr := os.Lstat(filepath.Join(root, "dst-dir")); !os.IsNotExist(statErr) {
		t.Fatalf("partial copy left behind, err=%v", statErr)
	}
}

func TestCopyFileSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink permissions vary on Windows")
	}
	root := t.TempDir()
	target := filepath.Join(root, "target.txt")
	must(t, os.WriteFile(target, []byte("target-content"), 0o644))
	link := filepath.Join(root, "link.txt")
	must(t, os.Symlink("target.txt", link))

	dispatchOK(t, mustFS(t, root), "fs.copyFile", map[string]any{
		"fromRelPath": "link.txt",
		"toRelPath":   "link-copy.txt",
	})

	dstLink := filepath.Join(root, "link-copy.txt")
	info, err := os.Lstat(dstLink)
	must(t, err)
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("destination is not a symlink")
	}
	linkTarget, err := os.Readlink(dstLink)
	must(t, err)
	if linkTarget != "target.txt" {
		t.Fatalf("symlink target mismatch: got %s, want target.txt", linkTarget)
	}
	if got, err := os.ReadFile(dstLink); err != nil || string(got) != "target-content" {
		t.Fatalf("following copied symlink failed: bytes=%q err=%v", got, err)
	}
	if infoSrc, err := os.Lstat(link); err != nil || infoSrc.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("source symlink should remain: err=%v", err)
	}
}

func TestRemoveAllFileRejects(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file.txt")
	must(t, os.WriteFile(file, []byte("payload"), 0o644))

	_, err := mustFS(t, root).RemoveAll(context.Background(), mustJSON(t, map[string]any{
		"relPath": "file.txt",
	}))
	assertFSError(t, err, CodeNotDirectory)
	if got, readErr := os.ReadFile(file); readErr != nil || string(got) != "payload" {
		t.Fatalf("file should remain after rejected removeAll: bytes=%q err=%v", got, readErr)
	}
}

func TestRemoveAllMissingIsNoop(t *testing.T) {
	root := t.TempDir()
	dispatchOK(t, mustFS(t, root), "fs.removeAll", map[string]any{
		"relPath": "never-existed",
	})
}

func mustFS(t *testing.T, root string) *Service {
	t.Helper()
	fsys, err := New(root)
	must(t, err)
	return fsys
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	must(t, err)
	return b
}

func callWrite(t *testing.T, fsys *Service, payload map[string]any) WriteFileResult {
	t.Helper()
	res, err := fsys.WriteFile(context.Background(), mustJSON(t, payload))
	must(t, err)
	wr, ok := res.(WriteFileResult)
	if !ok {
		t.Fatalf("unexpected result type %T", res)
	}
	return wr
}

func dispatchOK(t *testing.T, fsys *Service, method string, payload map[string]any) {
	t.Helper()
	d := dispatch.New()
	Register(d, fsys)
	res := d.Dispatch(context.Background(), proto.Request{
		ID:     method,
		Method: method,
		Params: mustJSON(t, payload),
	})
	if res.Error != nil {
		t.Fatalf("%s returned error: %#v", method, res.Error)
	}
}

func assertFSError(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s error", code)
	}
	if fsErr, ok := err.(FSError); !ok || fsErr.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func TestWriteFile_PreservesMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows keeps no POSIX mode bits")
	}
	root := t.TempDir()
	for name, mode := range map[string]os.FileMode{"run.sh": 0o755, ".env": 0o600, "shared.txt": 0o664} {
		path := filepath.Join(root, name)
		must(t, os.WriteFile(path, []byte("v1"), 0o644))
		must(t, os.Chmod(path, mode))

		res := callWrite(t, mustFS(t, root), map[string]any{"relPath": name, "content": "v2"})
		if res.Kind != "ok" {
			t.Fatalf("%s: expected ok, got %q", name, res.Kind)
		}
		info, err := os.Stat(path)
		must(t, err)
		if info.Mode().Perm() != mode {
			t.Fatalf("%s: mode %o after save, want %o", name, info.Mode().Perm(), mode)
		}
	}
}

func TestWriteFile_HardLinkWrittenInPlace(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "a.txt")
	must(t, os.WriteFile(path, []byte("v1"), 0o644))
	must(t, os.Link(path, filepath.Join(root, "b.txt")))

	res := callWrite(t, mustFS(t, root), map[string]any{"relPath": "a.txt", "content": "v2"})
	if res.Kind != "ok" {
		t.Fatalf("expected ok, got %q", res.Kind)
	}
	got, err := os.ReadFile(filepath.Join(root, "b.txt"))
	must(t, err)
	if string(got) != "v2" {
		t.Fatalf("hard link content %q, want v2", got)
	}
}

func TestUploadPathEscape(t *testing.T) {
	for _, kind := range []string{"relative", "absolute", "parent link", "destination link", "replaced parent"} {
		t.Run(kind, func(t *testing.T) {
			if runtime.GOOS == "windows" && strings.Contains(kind, "link") {
				t.Skip("creating symlinks requires privileges on Windows")
			}
			if kind == "replaced parent" && runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
				t.Skip("directory handles anchor the temporary file on Linux and macOS")
			}
			root, outside := t.TempDir(), t.TempDir()
			s, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(s.Close)
			ctx := context.Background()
			p := uploadParams{UploadID: "a0000000-0000-4000-8000-000000000000"}
			switch kind {
			case "relative":
				p.RelPath = "../outside"
			case "absolute":
				p.RelPath = filepath.Join(outside, "file")
			case "parent link", "destination link":
				if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
					t.Fatal(err)
				}
				p.RelPath = "link"
				if kind == "parent link" {
					p.RelPath += "/file"
				}
			case "replaced parent":
				parent := filepath.Join(root, "nested")
				moved := filepath.Join(root, "moved")
				if err := os.Mkdir(parent, 0o700); err != nil {
					t.Fatal(err)
				}
				p.RelPath = "nested/file"
				dest, err := s.uploadDestination(p.RelPath, false)
				if err != nil {
					t.Fatal(err)
				}
				p.ExpectedPath = dest.path
				if _, err := s.beginUpload(ctx, p); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(parent, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, parent); err != nil {
					t.Fatal(err)
				}
				p.SHA256 = fmt.Sprintf("%x", sha256.Sum256(nil))
				if _, err := s.verifyUpload(ctx, p); err != nil {
					t.Fatal(err)
				}
				_, err = s.commitUpload(ctx, p)
				if proto.ErrorCode(err) != CodeOutOfWorkspace {
					t.Fatalf("committing through a replaced parent: %v", err)
				}
				entries, err := os.ReadDir(moved)
				if err != nil || len(entries) != 0 {
					t.Fatalf("temporary file in moved directory: %v, %v", entries, err)
				}
			}
			if kind != "replaced parent" {
				dest, err := s.uploadDestination(p.RelPath, false)
				if err == nil {
					p.ExpectedPath = dest.path
					_, err = s.beginUpload(ctx, p)
				}
				if proto.ErrorCode(err) != CodeOutOfWorkspace {
					t.Fatalf("upload destination escaped: %v", err)
				}
			}
			entries, err := os.ReadDir(outside)
			if err != nil || len(entries) != 0 {
				t.Fatalf("upload changed the outside directory: %v, %v", entries, err)
			}
		})
	}
}

func TestUploadCleanup(t *testing.T) {
	for _, kind := range []string{"verified commit", "hash mismatch", "abort", "disconnect"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			s, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(s.Close)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			p := uploadParams{UploadID: "b0000000-0000-4000-8000-000000000000", RelPath: "data", Size: 3}
			dest, err := s.uploadDestination(p.RelPath, false)
			if err != nil {
				t.Fatal(err)
			}
			p.ExpectedPath = dest.path
			if err := os.WriteFile(dest.path, []byte("old"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := s.beginUpload(ctx, p); err != nil {
				t.Fatal(err)
			}
			for _, piece := range []struct {
				offset int64
				base64 string
			}{{1, "ZXc="}, {0, "bg=="}} {
				p.Offset, p.Data = piece.offset, piece.base64
				if _, err := s.chunkUpload(ctx, p); err != nil {
					t.Fatal(err)
				}
			}
			want := "old"
			switch kind {
			case "verified commit":
				p.SHA256 = fmt.Sprintf("%x", sha256.Sum256([]byte("new")))
				if _, err := s.verifyUpload(ctx, p); err != nil {
					t.Fatal(err)
				}
				if _, err := s.commitUpload(ctx, p); err != nil {
					t.Fatal(err)
				}
				want = "new"
				if runtime.GOOS != "windows" {
					info, err := os.Stat(dest.path)
					if err != nil || info.Mode().Perm() != 0o600 {
						t.Fatalf("destination mode changed: %v, %v", info, err)
					}
				}
			case "hash mismatch":
				p.SHA256 = fmt.Sprintf("%x", sha256.Sum256([]byte("bad")))
				if _, err := s.verifyUpload(ctx, p); err == nil || !strings.Contains(err.Error(), "SHA-256 did not match") {
					t.Fatalf("verification error: %v", err)
				}
			case "abort":
				if _, err := s.abortUpload(ctx, p); err != nil {
					t.Fatal(err)
				}
			case "disconnect":
				cancel()
				s.DropUploads(ctx)
			}
			if entries, err := os.ReadDir(root); err != nil || len(entries) != 1 {
				t.Fatalf("temporary upload remains: %v, %v", entries, err)
			}
			if data, err := os.ReadFile(dest.path); err != nil || string(data) != want {
				t.Fatalf("destination changed: %q, %v", data, err)
			}
		})
	}
}

func TestBeginUploadRemovesStaleTemporaryFiles(t *testing.T) {
	for _, test := range []struct {
		kind, name string
		kept       bool
	}{
		{"abandoned file", uploadPrefix + "a0000000-0000-4000-8000-000000000000" + uploadSuffix, false},
		{"recent file", uploadPrefix + "b0000000-0000-4000-8000-000000000000" + uploadSuffix, true},
		{"unrelated file", uploadPrefix + "not-an-upload" + uploadSuffix, true},
		{"matching directory", uploadPrefix + "c0000000-0000-4000-8000-000000000000" + uploadSuffix, true},
	} {
		t.Run(test.kind, func(t *testing.T) {
			root := t.TempDir()
			entry := filepath.Join(root, test.name)
			if test.kind == "matching directory" {
				must(t, os.Mkdir(entry, 0o700))
			} else {
				must(t, os.WriteFile(entry, nil, 0o600))
			}
			if test.kind != "recent file" {
				old := time.Now().Add(-25 * time.Hour)
				must(t, os.Chtimes(entry, old, old))
			}
			s, err := New(root)
			must(t, err)
			t.Cleanup(s.Close)
			dest, err := s.uploadDestination("data", false)
			must(t, err)
			_, err = s.beginUpload(context.Background(), uploadParams{
				UploadID: "d0000000-0000-4000-8000-000000000000",
				RelPath:  "data", ExpectedPath: dest.path,
			})
			must(t, err)
			_, err = os.Lstat(entry)
			if test.kept && err != nil || !test.kept && !os.IsNotExist(err) {
				t.Fatalf("expected kept=%v, got stat error %v", test.kept, err)
			}
		})
	}
}
