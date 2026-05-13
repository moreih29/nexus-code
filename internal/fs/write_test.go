package fs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

// TestWriteFile_NewFile_OK — first write of a path that does not exist
// yet, with the matching `expected.exists=false`. The wire result should
// be the "ok" variant and the bytes must land on disk.
func TestWriteFile_NewFile_OK(t *testing.T) {
	root := t.TempDir()
	res := callWrite(t, mustFS(t, root), map[string]any{
		"relPath":  "hello.txt",
		"content":  "world",
		"expected": map[string]any{"exists": false},
	})
	if res.Kind != "ok" {
		t.Fatalf("expected ok, got %q", res.Kind)
	}
	if res.MTime == nil || res.Size == nil || *res.Size != int64(len("world")) {
		t.Fatalf("ok variant missing mtime/size: %+v", res)
	}

	got, err := os.ReadFile(filepath.Join(root, "hello.txt"))
	must(t, err)
	if string(got) != "world" {
		t.Fatalf("unexpected content: %q", got)
	}
}

// TestWriteFile_ExistingMatch_OK — overwrite when the caller's expected
// mtime+size match the on-disk state.
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

// TestWriteFile_NoExpectation_OverwriteOK — when expected is omitted, the
// server overwrites unconditionally when the caller chooses to bypass the
// concurrency check.
func TestWriteFile_NoExpectation_OverwriteOK(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("v1"), 0o644))

	res := callWrite(t, mustFS(t, root), map[string]any{
		"relPath": "a.txt",
		"content": "v2",
	})
	if res.Kind != "ok" {
		t.Fatalf("expected ok, got %q", res.Kind)
	}
	got, err := os.ReadFile(filepath.Join(root, "a.txt"))
	must(t, err)
	if string(got) != "v2" {
		t.Fatalf("expected overwrite, got %q", got)
	}
}

// TestWriteFile_ExpectedFalse_ButExists_Conflict — caller said "this is a
// new file" but the target already exists. The actual state must be the
// "exists:true" variant so the renderer can decide whether to reload.
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

// TestWriteFile_ExpectedTrue_ButMissing_Conflict — caller said the file
// existed but it's gone now. The actual variant must be exists:false.
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
	// Ghost file must not have been created.
	if _, err := os.Stat(filepath.Join(root, "ghost.txt")); !os.IsNotExist(err) {
		t.Fatalf("conflict path should not create file: %v", err)
	}
}

// TestWriteFile_Directory_Refused — writing onto a directory must return
// IS_DIRECTORY rather than silently replacing it via atomic rename.
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

// TestWriteFile_OutOfWorkspace_Refused — paths escaping the root must
// be rejected by Resolve before any filesystem work happens.
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

// TestWriteFile_AtomicNoTmpResidue — after a successful write, the
// directory must contain only the target file. Catches a regression
// where the tmp file is left behind on a successful rename.
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

func TestCreateFileAndMkdir(t *testing.T) {
	root := t.TempDir()
	fsys := mustFS(t, root)

	_, err := fsys.CreateFile(context.Background(), mustJSON(t, map[string]any{
		"relPath": "empty.txt",
	}))
	must(t, err)
	if got, err := os.ReadFile(filepath.Join(root, "empty.txt")); err != nil || len(got) != 0 {
		t.Fatalf("created file mismatch: bytes=%q err=%v", got, err)
	}

	_, err = fsys.Mkdir(context.Background(), mustJSON(t, map[string]any{
		"relPath": "src",
	}))
	must(t, err)
	if info, err := os.Lstat(filepath.Join(root, "src")); err != nil || !info.IsDir() {
		t.Fatalf("created dir mismatch: info=%v err=%v", info, err)
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

func TestUnlinkFileViaDispatcher(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "gone.txt"), []byte("x"), 0o644))

	dispatchOK(t, mustFS(t, root), "fs.unlink", map[string]any{"relPath": "gone.txt"})
	if _, err := os.Lstat(filepath.Join(root, "gone.txt")); !os.IsNotExist(err) {
		t.Fatalf("expected file to be unlinked, got err=%v", err)
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

func TestRmdirEmptyViaDispatcher(t *testing.T) {
	root := t.TempDir()
	must(t, os.Mkdir(filepath.Join(root, "empty"), 0o755))

	dispatchOK(t, mustFS(t, root), "fs.rmdir", map[string]any{"relPath": "empty"})
	if _, err := os.Lstat(filepath.Join(root, "empty")); !os.IsNotExist(err) {
		t.Fatalf("expected directory removed, got err=%v", err)
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

func TestRenameHappyViaDispatcher(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "old.txt"), []byte("payload"), 0o644))

	dispatchOK(t, mustFS(t, root), "fs.rename", map[string]any{
		"fromRelPath": "old.txt",
		"toRelPath":   "new.txt",
	})
	if _, err := os.Lstat(filepath.Join(root, "old.txt")); !os.IsNotExist(err) {
		t.Fatalf("expected old path removed, got err=%v", err)
	}
	if got, err := os.ReadFile(filepath.Join(root, "new.txt")); err != nil || string(got) != "payload" {
		t.Fatalf("renamed file mismatch: bytes=%q err=%v", got, err)
	}
}

func TestRenameCrossDeviceMapsEXDEV(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "old.txt"), []byte("payload"), 0o644))
	orig := renamePath
	renamePath = func(oldpath, newpath string) error {
		return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: syscall.EXDEV}
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

// --- helpers -----------------------------------------------------------

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
