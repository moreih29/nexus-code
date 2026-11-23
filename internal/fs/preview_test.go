package fs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/nexus-code/nexus-code/internal/proto"
)

func previewFixture(t *testing.T) (*Service, string) {
	t.Helper()
	dir := t.TempDir()
	root := filepath.Join(dir, "workspace")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	service, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	return service, root
}

func previewRequest(t *testing.T, s *Service, p previewParams) (previewResult, error) {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	result, err := s.ReadPreview(context.Background(), raw)
	if err != nil {
		return previewResult{}, err
	}
	return result.(previewResult), nil
}

func putPreviewFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestPreviewPinsSameFileAcrossRangesAndDetectsSameSizeEdits(t *testing.T) {
	s, root := previewFixture(t)
	file := filepath.Join(root, "doc.txt")
	putPreviewFile(t, file, "old text")
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	params := previewParams{RelPath: "doc.txt", Length: 3, VersionScope: "workspace"}
	first, err := previewRequest(t, s, params)
	if err != nil || first.Base64 != "b2xk" || first.Size != 8 {
		t.Fatalf("first read: %+v %v", first, err)
	}
	if first.Version == "" {
		t.Skip("filesystem does not issue preview versions")
	}
	unchanged, err := previewRequest(t, s, previewParams{
		RelPath: params.RelPath, IfVersion: first.Version, VersionScope: params.VersionScope,
	})
	if err != nil || unchanged.Kind != "notModified" || unchanged.Base64 != "" || unchanged.Version != first.Version {
		t.Fatalf("conditional read: %+v %v", unchanged, err)
	}
	piece, err := previewRequest(t, s, previewParams{
		RelPath: params.RelPath, Length: 4, Offset: 4, RequireVersion: first.Version, VersionScope: params.VersionScope,
	})
	if err != nil || piece.Base64 != "dGV4dA==" || piece.Size != 8 || piece.Version != first.Version {
		t.Fatalf("pinned range: %+v %v", piece, err)
	}
	putPreviewFile(t, file, "new text")
	if err := os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	params.IfVersion = first.Version
	edited, err := previewRequest(t, s, params)
	if err != nil || edited.Kind != "ok" || edited.Base64 != "bmV3" || edited.Size != first.Size || edited.Version == first.Version {
		t.Fatalf("same-size edit with restored mtime: %+v %v", edited, err)
	}
	params.IfVersion, params.RequireVersion = "", first.Version
	if _, err := previewRequest(t, s, params); proto.ErrorCode(err) != CodeStale {
		t.Fatalf("old pin after edit: %v", err)
	}
}

func TestPreviewChecksNameAndOpenedFile(t *testing.T) {
	s, root := previewFixture(t)
	file := filepath.Join(root, "photo.png")
	putPreviewFile(t, file, "image data for the caller")
	params := previewParams{RelPath: "photo.png", WholeImage: true, VersionScope: "workspace"}
	first, err := previewRequest(t, s, params)
	if err != nil || first.Base64 != base64.StdEncoding.EncodeToString([]byte("image data for the caller")) {
		t.Fatalf("whole image read: %+v %v", first, err)
	}
	params.WholeImage = false
	probe, err := previewRequest(t, s, params)
	if err != nil || probe.Base64 != "" || probe.Size != first.Size || probe.Version != first.Version {
		t.Fatalf("metadata probe: %+v %v", probe, err)
	}
	params.IfVersion = first.Version
	if err := os.Rename(file, filepath.Join(root, "moved.png")); err != nil {
		t.Fatal(err)
	}
	putPreviewFile(t, file, "replacement")
	replaced, err := previewRequest(t, s, params)
	if err != nil || replaced.Kind != "ok" || replaced.Size != 11 || (first.Version != "" && replaced.Version == first.Version) {
		t.Fatalf("replacement: %+v %v", replaced, err)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(file, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := previewRequest(t, s, params); proto.ErrorCode(err) != CodeIsDirectory {
		t.Fatalf("directory replacement: %v", err)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if _, err := previewRequest(t, s, params); proto.ErrorCode(err) != CodeNotFound {
		t.Fatalf("missing: %v", err)
	}
}

func TestPreviewSymlinkRootAndGrantPolicy(t *testing.T) {
	s, root := previewFixture(t)
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks requires a developer-mode or elevated Windows runner")
	}
	alias := filepath.Join(filepath.Dir(root), "root-alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	s, err := New(alias)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "doc.txt")
	putPreviewFile(t, file, "inside")
	out := filepath.Join(filepath.Dir(root), "output.txt")
	putPreviewFile(t, out, "outside")
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(out, link); err != nil {
		t.Fatal(err)
	}
	if got, err := previewRequest(t, s, previewParams{RelPath: "doc.txt", Length: 6}); err != nil || got.Base64 != "aW5zaWRl" {
		t.Fatalf("workspace root alias: %+v %v", got, err)
	}
	if _, err := previewRequest(t, s, previewParams{RelPath: "link.txt", IfVersion: "some-version", VersionScope: "workspace"}); proto.ErrorCode(err) != CodeOutOfWorkspace {
		t.Fatalf("workspace link must be refused: %v", err)
	}
	if got, err := previewRequest(t, s, previewParams{AbsolutePath: link, Length: 7}); err != nil || got.Base64 != "b3V0c2lkZQ==" {
		t.Fatalf("named file grant may follow link: %+v %v", got, err)
	}
	real, err := filepath.EvalSymlinks(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := previewRequest(t, s, previewParams{AbsolutePath: link, ExpectedRealPath: real}); proto.ErrorCode(err) != CodeOutOfWorkspace {
		t.Fatalf("folder grant cannot follow retargeted link: %v", err)
	}
}

func TestPreviewFolderGrantAcceptsAnotherSpellingOfTheAuthorizedFile(t *testing.T) {
	s, root := previewFixture(t)
	dir := filepath.Join(root, "Proj")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "README.md")
	putPreviewFile(t, file, "readme")
	other := filepath.Join(dir, "other.md")
	putPreviewFile(t, other, "other")
	respelled := filepath.Join(root, "proj", "readme.md")
	if _, err := os.Stat(respelled); err != nil {
		t.Skip("file system is case-sensitive")
	}
	got, err := previewRequest(t, s, previewParams{AbsolutePath: respelled, ExpectedRealPath: file, Length: 6})
	if err != nil || got.Base64 != "cmVhZG1l" {
		t.Fatalf("respelled path of the authorized file: %+v %v", got, err)
	}
	if _, err := previewRequest(t, s, previewParams{AbsolutePath: respelled, ExpectedRealPath: other, Length: 6}); proto.ErrorCode(err) != CodeOutOfWorkspace {
		t.Fatalf("another file must be refused: %v", err)
	}
}

func TestPreviewLargeFileFallsBackToFreshRange(t *testing.T) {
	s, root := previewFixture(t)
	const name = "large.bin"
	file, err := os.Create(filepath.Join(root, name))
	if err != nil {
		t.Fatal(err)
	}
	size := int64(maxPreviewVersionBytes + 1)
	if err := file.Truncate(size); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	params := previewParams{
		RelPath: name, Offset: size - 1, Length: 1, VersionScope: "workspace", IfVersion: "stale",
	}
	got, err := previewRequest(t, s, params)
	if err != nil || got.Kind != "ok" || got.Base64 != "AA==" || got.Version != "" || got.Size != size {
		t.Fatalf("oversized range: %+v %v", got, err)
	}
	params.IfVersion = ""
	params.RequireVersion = "stale"
	if _, err := previewRequest(t, s, params); proto.ErrorCode(err) != CodeStale {
		t.Fatalf("oversized read could not satisfy pin: %v", err)
	}
}
