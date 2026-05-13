package fs

import (
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/nexus-code/nexus-code/internal/content"
)

// entryType classifies one DirEntry as "dir" / "symlink" / "file".
func entryType(entry os.DirEntry) string {
	if entry.IsDir() {
		return "dir"
	}
	if entry.Type()&os.ModeSymlink != 0 {
		return "symlink"
	}
	return "file"
}

// fileInfoType is the same classifier as entryType but for FileInfo.
func fileInfoType(info os.FileInfo) string {
	if info.IsDir() {
		return "dir"
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "symlink"
	}
	return "file"
}

// buildFileContent classifies the read bytes and packs them into the "ok"
// variant of ReadFileResult.
func buildFileContent(buf []byte, info os.FileInfo) ReadFileResult {
	probe := buf
	if len(probe) > content.BinaryProbeBytes {
		probe = probe[:content.BinaryProbeBytes]
	}
	mtime := formatMTime(info.ModTime())
	if content.IsBinaryProbe(probe) {
		return ReadFileResult{Kind: "ok", Content: "", Encoding: "utf8", Size: info.Size(), IsBinary: true, MTime: mtime}
	}
	if len(probe) >= 3 && probe[0] == 0xef && probe[1] == 0xbb && probe[2] == 0xbf {
		return ReadFileResult{Kind: "ok", Content: string(buf[3:]), Encoding: "utf8-bom", Size: info.Size(), IsBinary: false, MTime: mtime}
	}
	content := string(buf)
	if !utf8.Valid(buf) {
		content = strings.ToValidUTF8(content, "�")
	}
	return ReadFileResult{Kind: "ok", Content: content, Encoding: "utf8", Size: info.Size(), IsBinary: false, MTime: mtime}
}

// formatMTime renders a time as the wire-format ISO 8601 string used across
// all fs methods.
func formatMTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
