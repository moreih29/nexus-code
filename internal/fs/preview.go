package fs

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const maxPreviewImageBytes = 32 * 1024 * 1024

type previewParams struct {
	RelPath          string `json:"relPath"`
	AbsolutePath     string `json:"absolutePath"`
	ExpectedRealPath string `json:"expectedRealPath"`
	Offset           int64  `json:"offset"`
	Length           int64  `json:"length"`
	WholeImage       bool   `json:"wholeImage"`
	VersionScope     string `json:"versionScope"`
	IfVersion        string `json:"ifVersion"`
	RequireVersion   string `json:"requireVersion"`
}

type previewResult struct {
	Kind    string `json:"kind"`
	Base64  string `json:"base64"`
	Size    int64  `json:"sizeBytes"`
	Version string `json:"version,omitempty"`
}

type previewStamp struct {
	device, inode uint64
	change        int64
}

var previewKey = sync.OnceValues(func() ([32]byte, error) {
	var key [32]byte
	_, err := rand.Read(key[:])
	return key, err
})

// ReadPreview makes the access check, version comparison and any byte read
// on the same open file. Its path policy is narrower than the editor's range
// reader: workspace paths cannot follow links. For a granted folder, the
// caller supplies the canonical path it authorized. An explicit file grant
// permits following that filename as usual.
func (s *Service) ReadPreview(ctx context.Context, raw json.RawMessage) (any, error) {
	var p previewParams
	if json.Unmarshal(raw, &p) != nil || (p.RelPath == "") == (p.AbsolutePath == "") ||
		p.Offset < 0 || p.Length < 0 || p.Length > MaxReadRangeLength ||
		(p.IfVersion != "" && p.RequireVersion != "") {
		return nil, proto.ProtocolError("invalid fs.readPreview params")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	abs, err := parseAbsolutePath(raw)
	if p.RelPath != "" {
		abs, err = s.Resolve(p.RelPath)
	}
	if err != nil {
		return nil, err
	}
	resolve := func() (string, error) {
		if p.RelPath != "" {
			return s.previewWorkspacePath(abs)
		}
		real, err := filepath.EvalSymlinks(abs)
		if err == nil && p.ExpectedRealPath != "" && real != p.ExpectedRealPath {
			err = FSError{Code: CodeOutOfWorkspace, Path: abs}
		}
		return real, err
	}
	real, err := resolve()
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	target, err := os.Stat(real)
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	if err := previewRegular(target, abs); err != nil {
		return nil, err
	}
	file, versionable, err := openPreviewFile(real, p.VersionScope != "")
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	defer file.Close()

	before, err := file.Stat()
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	if err := previewRegular(before, abs); err != nil {
		return nil, err
	}
	changed := FSError{Code: CodeStale, Path: abs}
	if !os.SameFile(target, before) {
		return nil, changed
	}
	stamp, reliable := previewFileStamp(file, before, versionable)
	version := ""
	if reliable {
		key, err := previewKey()
		if err != nil {
			return nil, err
		}
		mac := hmac.New(sha256.New, key[:])
		fmt.Fprintf(mac, "%q %q %q %d %d %d %d %d %d", p.VersionScope, abs, real,
			stamp.device, stamp.inode, stamp.change, before.ModTime().UnixNano(), before.Size(), before.Mode())
		version = base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	}
	if p.RequireVersion != "" && p.RequireVersion != version {
		return nil, changed
	}
	result := previewResult{Kind: "ok", Size: before.Size(), Version: version}
	notModified := p.IfVersion != "" && p.IfVersion == version
	var buf []byte
	if !notModified {
		length := p.Length
		if p.WholeImage && before.Size() <= maxPreviewImageBytes {
			length = before.Size()
		}
		length = max(0, min(length, before.Size()-p.Offset))
		if length > 0 {
			buf = make([]byte, length)
			n, err := file.ReadAt(buf, p.Offset)
			if n != len(buf) && (err == nil || err == io.EOF) {
				return nil, changed
			}
			if err != nil {
				return nil, mapPathError(err, abs)
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Confirm the name still resolves per its grant and to the file we opened.
	// Together with a handle-relative, no-link open this also covers replacement
	// or a link being swapped in between path resolution and open.
	currentReal, err := resolve()
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	if currentReal != real {
		return nil, changed
	}
	current, err := os.Stat(real)
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	after, err := file.Stat()
	if err != nil {
		return nil, mapPathError(err, abs)
	}
	afterStamp, _ := previewFileStamp(file, after, false)
	if !os.SameFile(current, before) || stamp != afterStamp || before.Size() != after.Size() ||
		before.Mode() != after.Mode() || !before.ModTime().Equal(after.ModTime()) {
		return nil, changed
	}
	if notModified {
		return previewResult{Kind: "notModified", Version: version}, nil
	}
	result.Base64 = base64.StdEncoding.EncodeToString(buf)
	return result, nil
}

func (s *Service) previewWorkspacePath(abs string) (string, error) {
	rel, err := filepath.Rel(s.root, abs)
	if err != nil {
		return "", err
	}
	root, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return "", err
	}
	// Treat a symlink to the workspace root as the configured root. Links
	// within that root, including links that stay inside it, are forbidden.
	current := root
	for _, part := range strings.Split(rel, string(os.PathSeparator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", FSError{Code: CodeOutOfWorkspace, Path: abs}
		}
	}
	return current, nil
}

func previewRegular(info os.FileInfo, abs string) error {
	if info.IsDir() {
		return FSError{Code: CodeIsDirectory, Path: abs}
	}
	if !info.Mode().IsRegular() {
		return FSError{Code: CodeNotFound, Path: abs}
	}
	return nil
}

// Some Linux filesystems use coarse time for ctime on writes. A version is
// withheld while the last ctime tick could still be reused by another write.
func oldEnoughForPreviewVersion(change int64) bool {
	return change > 0 && time.Since(time.Unix(0, change)) > 100*time.Millisecond
}
