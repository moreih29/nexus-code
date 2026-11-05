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

func TestReadAbsoluteBinaryReadsOutsideTheRoot(t *testing.T) {
	root := t.TempDir()
	outsidePath := filepath.Join(t.TempDir(), "shot.png")
	must(t, os.WriteFile(outsidePath, []byte{0x89, 'P', 'N', 'G'}, 0o644))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	readAny, err := fsys.ReadAbsoluteBinary(context.Background(), json.RawMessage(`{"absolutePath":`+strconvQuote(outsidePath)+`}`))
	if err != nil {
		t.Fatal(err)
	}
	read := readAny.(ReadBinaryResult)
	if read.Kind != "ok" || read.Base64 != "iVBORw==" || read.Size != 4 {
		t.Fatalf("absolute binary read mismatch: %#v", read)
	}

	missingAny, err := fsys.ReadAbsoluteBinary(context.Background(), json.RawMessage(`{"absolutePath":`+strconvQuote(outsidePath+".gone")+`}`))
	if err != nil || missingAny.(ReadBinaryResult).Kind != "missing" {
		t.Fatalf("missing absolute binary read mismatch: %#v (err=%v)", missingAny, err)
	}

	if _, err := fsys.ReadAbsoluteBinary(context.Background(), json.RawMessage(`{"absolutePath":"shot.png"}`)); err == nil {
		t.Fatal("a relative path should be refused")
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

func TestReadRangeReadsAPieceWithTheFileSize(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "clip.bin"), []byte("0123456789"), 0o644))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	read := func(params string) ReadBinaryResult {
		t.Helper()
		got, err := fsys.ReadRange(context.Background(), json.RawMessage(params))
		if err != nil {
			t.Fatal(err)
		}
		return got.(ReadBinaryResult)
	}
	decoded := func(r ReadBinaryResult) string {
		t.Helper()
		b, err := base64.StdEncoding.DecodeString(r.Base64)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	mid := read(`{"relPath":"clip.bin","offset":2,"length":3}`)
	if mid.Kind != "ok" || decoded(mid) != "234" || mid.Size != 10 || mid.MTime == "" {
		t.Fatalf("range mismatch: %#v", mid)
	}
	if end := read(`{"relPath":"clip.bin","offset":8,"length":5}`); decoded(end) != "89" || end.Size != 10 {
		t.Fatalf("range past the end mismatch: %#v", end)
	}
	if past := read(`{"relPath":"clip.bin","offset":12,"length":5}`); past.Kind != "ok" || past.Base64 != "" || past.Size != 10 {
		t.Fatalf("range after the end mismatch: %#v", past)
	}
	if size := read(`{"relPath":"clip.bin","offset":0,"length":0}`); size.Base64 != "" || size.Size != 10 {
		t.Fatalf("empty range mismatch: %#v", size)
	}
	if missing := read(`{"relPath":"gone.bin","offset":0,"length":1}`); missing.Kind != "missing" {
		t.Fatalf("missing range mismatch: %#v", missing)
	}

	for _, params := range []string{
		`{"relPath":"clip.bin","offset":-1,"length":1}`,
		`{"relPath":"clip.bin","offset":0,"length":-1}`,
		`{"relPath":"clip.bin","offset":"0","length":1}`,
	} {
		if _, err := fsys.ReadRange(context.Background(), json.RawMessage(params)); proto.ErrorCode(err) != proto.CodeProtocolError {
			t.Fatalf("%s: expected protocol error, got %v", params, err)
		}
	}
	if _, err := fsys.ReadRange(context.Background(), json.RawMessage(`{"relPath":"../clip.bin","offset":0,"length":1}`)); err == nil {
		t.Fatal("a path out of the root should be refused")
	}
}

func TestReadRangeCapsOneCallsLength(t *testing.T) {
	root := t.TempDir()
	big := make([]byte, MaxReadRangeLength+10)
	for i := range big {
		big[i] = byte(i)
	}
	must(t, os.WriteFile(filepath.Join(root, "big.bin"), big, 0o644))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	got, err := fsys.ReadRange(context.Background(), json.RawMessage(`{"relPath":"big.bin","offset":5,"length":99999999}`))
	if err != nil {
		t.Fatal(err)
	}
	read := got.(ReadBinaryResult)
	b, err := base64.StdEncoding.DecodeString(read.Base64)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != MaxReadRangeLength || b[0] != 5 || read.Size != int64(len(big)) {
		t.Fatalf("capped range mismatch: len=%d first=%d size=%d", len(b), b[0], read.Size)
	}
}

func TestReadRangeFollowsSymlinkAndReadsOutsideByAbsolutePath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	root := t.TempDir()
	outsidePath := filepath.Join(t.TempDir(), "doc.pdf")
	must(t, os.WriteFile(outsidePath, []byte("%PDF-1.7 body"), 0o644))
	must(t, os.Symlink(outsidePath, filepath.Join(root, "link.pdf")))
	fsys, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	viaLink, err := fsys.ReadRange(context.Background(), json.RawMessage(`{"relPath":"link.pdf","offset":0,"length":4}`))
	if err != nil {
		t.Fatal(err)
	}
	if r := viaLink.(ReadBinaryResult); r.Base64 != base64.StdEncoding.EncodeToString([]byte("%PDF")) || r.Size != 13 {
		t.Fatalf("range through a link mismatch: %#v", r)
	}

	outside, err := fsys.ReadAbsoluteRange(context.Background(), json.RawMessage(`{"absolutePath":`+strconvQuote(outsidePath)+`,"offset":9,"length":4}`))
	if err != nil {
		t.Fatal(err)
	}
	if r := outside.(ReadBinaryResult); r.Base64 != base64.StdEncoding.EncodeToString([]byte("body")) || r.Size != 13 {
		t.Fatalf("absolute range mismatch: %#v", r)
	}
	if _, err := fsys.ReadAbsoluteRange(context.Background(), json.RawMessage(`{"absolutePath":"doc.pdf","offset":0,"length":1}`)); err == nil {
		t.Fatal("a relative path should be refused")
	}
}
