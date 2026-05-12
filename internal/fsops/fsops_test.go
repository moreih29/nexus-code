package fsops

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

func TestDispatcherResponseShapesMatchTypeScriptServer(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "alpha.txt"), []byte("alpha"), 0o644))
	must(t, os.Mkdir(filepath.Join(root, "src"), 0o755))
	must(t, os.Mkdir(filepath.Join(root, ".git"), 0o755))

	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	d := dispatch.New()
	Register(d, fsys)

	res := d.Dispatch(context.Background(), proto.Request{ID: "readdir-1", Method: "fs.readdir", Params: json.RawMessage(`{"relPath":"."}`)})
	line, err := proto.MarshalFrame(res)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"readdir-1","result":[{"name":"alpha.txt","type":"file"},{"name":"src","type":"dir"}]}` + "\n"
	if string(line) != want {
		t.Fatalf("readdir frame = %s, want %s", line, want)
	}

	res = d.Dispatch(context.Background(), proto.Request{ID: "read-1", Method: "fs.readFile", Params: json.RawMessage(`{"relPath":"alpha.txt"}`)})
	line, err = proto.MarshalFrame(res)
	if err != nil {
		t.Fatal(err)
	}
	matched, err := regexp.MatchString(`^\{"id":"read-1","result":\{"kind":"ok","content":"alpha","encoding":"utf8","sizeBytes":5,"isBinary":false,"mtime":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\}\}\n$`, string(line))
	if err != nil || !matched {
		t.Fatalf("readFile frame mismatch: %s (err=%v)", line, err)
	}
}

func TestStatReadFileMissingBinaryAndBOM(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "utf8-bom.txt"), append([]byte{0xef, 0xbb, 0xbf}, []byte("hello")...), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "bin.dat"), []byte{'H', 0, 'i'}, 0o644))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	statAny, err := fsys.Stat(context.Background(), json.RawMessage(`{"relPath":"utf8-bom.txt"}`))
	if err != nil {
		t.Fatal(err)
	}
	stat := statAny.(StatResult)
	if stat.Type != "file" || stat.Size != 8 || stat.IsSymlink {
		t.Fatalf("stat mismatch: %#v", stat)
	}

	readAny, err := fsys.ReadFile(context.Background(), json.RawMessage(`{"relPath":"utf8-bom.txt"}`))
	if err != nil {
		t.Fatal(err)
	}
	read := readAny.(ReadFileResult)
	if read.Kind != "ok" || read.Content != "hello" || read.Encoding != "utf8-bom" || read.Size != 8 || read.IsBinary {
		t.Fatalf("bom read mismatch: %#v", read)
	}

	readAny, err = fsys.ReadFile(context.Background(), json.RawMessage(`{"relPath":"bin.dat"}`))
	if err != nil {
		t.Fatal(err)
	}
	read = readAny.(ReadFileResult)
	if read.Kind != "ok" || read.Content != "" || !read.IsBinary {
		t.Fatalf("binary read mismatch: %#v", read)
	}

	readAny, err = fsys.ReadFile(context.Background(), json.RawMessage(`{"relPath":"missing.txt"}`))
	if err != nil {
		t.Fatal(err)
	}
	read = readAny.(ReadFileResult)
	if read.Kind != "missing" || read.Reason != "not-found" {
		t.Fatalf("missing read mismatch: %#v", read)
	}
}

func TestPathTraversalReturnsErrorFrame(t *testing.T) {
	fsys, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	d := dispatch.New()
	Register(d, fsys)
	res := d.Dispatch(context.Background(), proto.Request{ID: "escape", Method: "fs.stat", Params: json.RawMessage(`{"relPath":"../etc/passwd"}`)})
	if res.Error == nil || res.Error.Code != "OUT_OF_WORKSPACE" || res.Error.Message != "OUT_OF_WORKSPACE: ../etc/passwd" {
		t.Fatalf("escape response mismatch: %#v", res)
	}
}

func TestSymlinkSemanticsUseLstatAndDoNotEvalTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink permissions vary on Windows")
	}
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	must(t, os.WriteFile(outside, []byte("outside"), 0o644))
	must(t, os.Symlink(outside, filepath.Join(root, "link.txt")))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	statAny, err := fsys.Stat(context.Background(), json.RawMessage(`{"relPath":"link.txt"}`))
	if err != nil {
		t.Fatal(err)
	}
	stat := statAny.(StatResult)
	if stat.Type != "symlink" || !stat.IsSymlink {
		t.Fatalf("expected lstat symlink metadata, got %#v", stat)
	}
}

func TestInvalidParamsAreProtocolErrors(t *testing.T) {
	fsys, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = fsys.Stat(context.Background(), json.RawMessage(`{"relPath":1}`))
	if err == nil || proto.ErrorCode(err) != proto.CodeProtocolError {
		t.Fatalf("expected protocol error, got %v", err)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
