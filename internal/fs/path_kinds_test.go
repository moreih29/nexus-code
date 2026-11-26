package fs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type pathKindCase struct {
	Path string          `json:"path"`
	Kind windowsPathKind `json:"kind"`
}

func loadPathKinds(t *testing.T) []pathKindCase {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "tests", "fixtures", "windows-path-kinds.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []pathKindCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func TestClassifyWindowsPathMatchesSharedTable(t *testing.T) {
	seen := map[windowsPathKind]bool{}
	for _, c := range loadPathKinds(t) {
		seen[c.Kind] = true
		if got := classifyWindowsPath(c.Path); got != c.Kind {
			t.Errorf("classifyWindowsPath(%q) = %q, want %q", c.Path, got, c.Kind)
		}
	}
	for _, kind := range []windowsPathKind{windowsDevicePath, windowsUNCPath, windowsDrivePath, windowsRootedPath, windowsRelativePath} {
		if !seen[kind] {
			t.Errorf("the shared table has no %q path", kind)
		}
	}
}

func TestClassifyWindowsPathAgreesWithWindowsVolumes(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("volume names are Windows rules")
	}
	for _, c := range loadPathKinds(t) {
		volume := strings.ReplaceAll(filepath.VolumeName(c.Path), "/", `\`)
		device := false
		for _, prefix := range []string{`\\?`, `\\.`, `\??`} {
			rest, ok := strings.CutPrefix(volume, prefix)
			device = device || ok && (rest == "" || rest[0] == '\\')
		}
		if device != (c.Kind == windowsDevicePath) {
			t.Errorf("%q: volume %q, kind %q", c.Path, volume, c.Kind)
		}
		if unc := !device && strings.HasPrefix(volume, `\\`); unc != (c.Kind == windowsUNCPath) {
			t.Errorf("%q: volume %q, kind %q", c.Path, volume, c.Kind)
		}
	}
}

func TestParseAbsolutePathOnWindowsTakesOnlyDriveAndSharePaths(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("device volumes are Windows paths")
	}
	for _, c := range loadPathKinds(t) {
		raw, err := json.Marshal(ReadAbsoluteParams{AbsolutePath: c.Path})
		if err != nil {
			t.Fatal(err)
		}
		_, err = parseAbsolutePath(raw)
		want := c.Kind == windowsDrivePath || c.Kind == windowsUNCPath
		if want != (err == nil) {
			t.Errorf("parseAbsolutePath(%q) err = %v, kind %q", c.Path, err, c.Kind)
		}
		if c.Kind == windowsDevicePath {
			assertFSError(t, err, CodeNotFound)
		}
	}
}

func TestReadAbsoluteRefusesNTPrefixedSharesOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("NT prefixes are Windows paths")
	}
	fsys, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		`\??\UNC\127.0.0.1\qa-none-46\a.txt`,
		`/??/UNC/127.0.0.1/qa-none-46/a.txt`,
		`\??\C:\Windows\win.ini`,
		`\\?\UNC\127.0.0.1\qa-none-46\a.txt`,
		`//./C:/Windows/win.ini`,
	} {
		raw, err := json.Marshal(map[string]any{"absolutePath": path, "offset": 0, "length": 0})
		if err != nil {
			t.Fatal(err)
		}
		for name, read := range map[string]func(context.Context, json.RawMessage) (any, error){
			"ReadAbsolute":       fsys.ReadAbsolute,
			"ReadAbsoluteBinary": fsys.ReadAbsoluteBinary,
			"ReadAbsoluteRange":  fsys.ReadAbsoluteRange,
		} {
			_, err := read(context.Background(), raw)
			assertFSError(t, err, CodeNotFound)
			if !strings.Contains(err.Error(), "device paths are not read") {
				t.Errorf("%s(%q) = %v, want a refused device path", name, path, err)
			}
		}
	}
}
