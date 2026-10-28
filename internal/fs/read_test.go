package fs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
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

func TestReadBinaryReturnsBase64ForBinaryAndUtf8AndMissing(t *testing.T) {
	root := t.TempDir()
	binBytes := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01}
	must(t, os.WriteFile(filepath.Join(root, "logo.png"), binBytes, 0o644))
	must(t, os.WriteFile(filepath.Join(root, "notes.txt"), []byte("hello"), 0o644))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	// Binary file — base64 round-trips the exact bytes.
	readAny, err := fsys.ReadBinary(context.Background(), json.RawMessage(`{"relPath":"logo.png"}`))
	if err != nil {
		t.Fatal(err)
	}
	bin := readAny.(ReadBinaryResult)
	if bin.Kind != "ok" || bin.Size != int64(len(binBytes)) {
		t.Fatalf("binary read mismatch: %#v", bin)
	}
	decoded, err := base64.StdEncoding.DecodeString(bin.Base64)
	if err != nil {
		t.Fatalf("base64 decode failed: %v", err)
	}
	if string(decoded) != string(binBytes) {
		t.Fatalf("round-trip mismatch: %x vs %x", decoded, binBytes)
	}

	// Text file — readBinary doesn't care about content shape, just bytes.
	readAny, err = fsys.ReadBinary(context.Background(), json.RawMessage(`{"relPath":"notes.txt"}`))
	if err != nil {
		t.Fatal(err)
	}
	text := readAny.(ReadBinaryResult)
	if text.Kind != "ok" {
		t.Fatalf("text-as-binary read mismatch: %#v", text)
	}
	decoded, err = base64.StdEncoding.DecodeString(text.Base64)
	if err != nil || string(decoded) != "hello" {
		t.Fatalf("text round-trip: %q (err=%v)", decoded, err)
	}

	// Missing file resolves rather than errors, matching fs.readFile.
	readAny, err = fsys.ReadBinary(context.Background(), json.RawMessage(`{"relPath":"absent.png"}`))
	if err != nil {
		t.Fatal(err)
	}
	miss := readAny.(ReadBinaryResult)
	if miss.Kind != "missing" || miss.Reason != "not-found" {
		t.Fatalf("missing binary read mismatch: %#v", miss)
	}
}

func TestReadBinaryFrameShapeMatchesWire(t *testing.T) {
	root := t.TempDir()
	// Two bytes so the base64 output is short and easy to assert on.
	must(t, os.WriteFile(filepath.Join(root, "x.bin"), []byte{0x01, 0x02}, 0o644))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	d := dispatch.New()
	Register(d, fsys)

	res := d.Dispatch(context.Background(), proto.Request{ID: "rb-1", Method: "fs.readBinary", Params: json.RawMessage(`{"relPath":"x.bin"}`)})
	line, err := proto.MarshalFrame(res)
	if err != nil {
		t.Fatal(err)
	}
	matched, err := regexp.MatchString(`^\{"id":"rb-1","result":\{"kind":"ok","base64":"AQI=","sizeBytes":2,"mtime":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\}\}\n$`, string(line))
	if err != nil || !matched {
		t.Fatalf("readBinary frame mismatch: %s (err=%v)", line, err)
	}
}

func TestReadAbsoluteUsesAgentHostPath(t *testing.T) {
	root := t.TempDir()
	outsideRoot := t.TempDir()
	outsidePath := filepath.Join(outsideRoot, "external.ts")
	must(t, os.WriteFile(outsidePath, []byte("external"), 0o644))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	readAny, err := fsys.ReadAbsolute(context.Background(), json.RawMessage(`{"absolutePath":`+strconvQuote(outsidePath)+`}`))
	if err != nil {
		t.Fatal(err)
	}
	read := readAny.(ReadFileResult)
	if read.Kind != "ok" || read.Content != "external" {
		t.Fatalf("absolute read mismatch: %#v", read)
	}

	_, err = fsys.ReadAbsolute(context.Background(), json.RawMessage(`{"absolutePath":"relative.ts"}`))
	if err == nil || proto.ErrorCode(err) != CodeNotFound || err.Error() != "NOT_FOUND: path must be absolute: relative.ts" {
		t.Fatalf("relative absolute read error mismatch: %v", err)
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

func strconvQuote(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func TestReaddirHidesOnlyVCSAndOSMetadata(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{".git", "node_modules", "dist", "out", ".next", "src"} {
		must(t, os.Mkdir(filepath.Join(root, dir), 0o755))
	}
	must(t, os.WriteFile(filepath.Join(root, ".DS_Store"), nil, 0o644))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	names := func(params string) []string {
		t.Helper()
		res, err := fsys.Readdir(context.Background(), json.RawMessage(params))
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, e := range res.([]DirEntry) {
			out = append(out, e.Name)
		}
		sort.Strings(out)
		return out
	}

	got := names(`{"relPath":"."}`)
	want := []string{".next", "dist", "node_modules", "out", "src"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("readdir = %v, want %v", got, want)
	}

	got = names(`{"relPath":".","includeHidden":true}`)
	want = []string{".DS_Store", ".git", ".next", "dist", "node_modules", "out", "src"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("readdir includeHidden = %v, want %v", got, want)
	}
}

// The size cap must hold for what a read actually consumes. A symlink's own
// Lstat size is a few bytes, so a link to a device or to an oversized file
// used to be read without bound.
func TestReadFollowsSymlinkWithinSizeCap(t *testing.T) {
	root := t.TempDir()
	big := filepath.Join(t.TempDir(), "big.bin")
	f, err := os.Create(big)
	must(t, err)
	must(t, f.Truncate(MaxReadableFileSize+1))
	must(t, f.Close())
	if err := os.Symlink(big, filepath.Join(root, "big.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	for _, read := range []func(context.Context, json.RawMessage) (any, error){fsys.ReadFile, fsys.ReadBinary} {
		_, err := read(ctx, json.RawMessage(`{"relPath":"big.txt"}`))
		var fsErr FSError
		if !errors.As(err, &fsErr) || fsErr.Code != CodeTooLarge {
			t.Fatalf("link to oversized file: want TOO_LARGE, got %v", err)
		}
	}
}

// TestReadFollowsSymlinkToDevice reads a link to an endless device as an
// empty binary file instead of reading the device without bound.
func TestReadFollowsSymlinkToDevice(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no /dev/zero")
	}
	root := t.TempDir()
	must(t, os.Symlink("/dev/zero", filepath.Join(root, "zero.txt")))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	readAny, err := fsys.ReadFile(ctx, json.RawMessage(`{"relPath":"zero.txt"}`))
	if err != nil {
		t.Fatal(err)
	}
	if read := readAny.(ReadFileResult); read.Kind != "ok" || !read.IsBinary || read.Content != "" {
		t.Fatalf("link to device: want empty binary result, got %#v", read)
	}
	binAny, err := fsys.ReadBinary(ctx, json.RawMessage(`{"relPath":"zero.txt"}`))
	if err != nil {
		t.Fatal(err)
	}
	if bin := binAny.(ReadBinaryResult); bin.Kind != "ok" || bin.Base64 != "" {
		t.Fatalf("link to device: want empty binary result, got %#v", bin)
	}
}
