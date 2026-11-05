package fs

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Text not in UTF-8 goes to the reader as its bytes, and comes back as
// bytes to write, so a save keeps the file's own encoding.
func TestTextNotInUTF8ReadsAsBytes(t *testing.T) {
	root := t.TempDir()
	files := map[string][]byte{
		"latin1.txt":  []byte("caf\xe9\n"),
		"euckr.txt":   {0xc7, 0xd1, 0xb1, 0xdb, '\n'},
		"utf16le.txt": {0xff, 0xfe, 'h', 0, 'i', 0},
		"utf16be.txt": {0xfe, 0xff, 0, 'h', 0, 'i'},
	}
	for name, data := range files {
		must(t, os.WriteFile(filepath.Join(root, name), data, 0o644))
	}
	fsys := mustFS(t, root)
	for name, data := range files {
		readAny, err := fsys.ReadFile(context.Background(), mustJSON(t, map[string]any{"relPath": name}))
		must(t, err)
		read := readAny.(ReadFileResult)
		if read.Kind != "ok" || read.Encoding != "bytes" || read.Content != "" || read.IsBinary || !bytes.Equal(read.Bytes, data) {
			t.Fatalf("%s: %#v", name, read)
		}
		wire, err := json.Marshal(read)
		must(t, err)
		if !strings.Contains(string(wire), `"bytes":"`) {
			t.Fatalf("%s: no bytes on the wire: %s", name, wire)
		}
	}

	// UTF-8 keeps its text, and no bytes go with it.
	must(t, os.WriteFile(filepath.Join(root, "utf8.txt"), []byte("한글\n"), 0o644))
	readAny, err := fsys.ReadFile(context.Background(), mustJSON(t, map[string]any{"relPath": "utf8.txt"}))
	must(t, err)
	wire, err := json.Marshal(readAny)
	must(t, err)
	if strings.Contains(string(wire), `"bytes"`) || !strings.Contains(string(wire), `"encoding":"utf8"`) {
		t.Fatalf("utf8 wire: %s", wire)
	}
}

func TestWriteFileWritesBytes(t *testing.T) {
	root := t.TempDir()
	fsys := mustFS(t, root)
	data := []byte{0xc7, 0xd1, 0xb1, 0xdb, '\n'}
	res := callWrite(t, fsys, map[string]any{
		"relPath":  "euckr.txt",
		"content":  "",
		"bytes":    data,
		"expected": map[string]any{"exists": false},
	})
	if res.Kind != "ok" || res.Size == nil || *res.Size != int64(len(data)) {
		t.Fatalf("write result: %+v", res)
	}
	got, err := os.ReadFile(filepath.Join(root, "euckr.txt"))
	must(t, err)
	if !bytes.Equal(got, data) {
		t.Fatalf("on disk: %x", got)
	}

	_, err = fsys.WriteFile(context.Background(), mustJSON(t, map[string]any{
		"relPath": "both.txt",
		"content": "text",
		"bytes":   data,
	}))
	if err == nil || !strings.Contains(err.Error(), "content or bytes") {
		t.Fatalf("err = %v, want content and bytes refused together", err)
	}
}
