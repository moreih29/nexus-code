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

func sameResolvedFile(real, expected string) bool {
	if real == expected {
		return true
	}
	a, err := os.Stat(real)
	if err != nil {
		return false
	}
	b, err := os.Stat(expected)
	return err == nil && os.SameFile(a, b)
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
	var abs string
	var err error
	if p.RelPath != "" {
		abs, err = s.Resolve(p.RelPath)
	} else {
		abs, err = parseAbsolutePath(raw)
	}
	if err != nil {
		return nil, err
	}
	resolve := func() (string, error) {
		if p.RelPath != "" {
			return s.previewWorkspacePath(abs)
		}
		real, err := filepath.EvalSymlinks(abs)
		if err == nil && p.ExpectedRealPath != "" && !sameResolvedFile(real, p.ExpectedRealPath) {
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
	file, err := openPreviewFile(real)
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
	stamp, versionable := previewFileStamp(file, before, p.VersionScope != "" && before.Size() <= maxPreviewVersionBytes)
	length := p.Length
	if p.WholeImage && before.Size() <= maxPreviewImageBytes {
		length = before.Size()
	}
	length = max(0, min(length, before.Size()-p.Offset))

	var buf []byte
	var proof []previewDigest
	var version string
	if versionable {
		key, err := previewKey()
		if err != nil {
			return nil, err
		}
		mac := hmac.New(sha256.New, key[:])
		fmt.Fprintf(mac, "%q %q %q %d %d %d %d %d %d", p.VersionScope, abs, real,
			stamp.device, stamp.inode, stamp.change, before.ModTime().UnixNano(), before.Size(), before.Mode())
		metadata := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
		if p.RequireVersion != "" && !strings.HasPrefix(p.RequireVersion, metadata+".") {
			return nil, changed
		}
		if pinned := previewProofFor(p.RequireVersion); len(pinned) > 0 && length > 0 {
			buf, err = readProvenPreviewRange(file, before.Size(), p.Offset, length, pinned)
			version = p.RequireVersion
		} else {
			select {
			case previewFingerprintSlots <- struct{}{}:
				defer func() { <-previewFingerprintSlots }()
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			var contents []byte
			contents, err = readPreviewRange(file, 0, before.Size())
			if err == nil {
				version, proof = provePreview(key, metadata, contents)
				if length > 0 {
					buf = contents[p.Offset : p.Offset+length]
				}
			}
		}
		if err != nil {
			return nil, mapPathError(err, abs)
		}
	}
	if p.RequireVersion != "" && p.RequireVersion != version {
		return nil, changed
	}
	if !versionable {
		buf, err = readPreviewRange(file, p.Offset, length)
		if err != nil {
			return nil, mapPathError(err, abs)
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

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
	if proof != nil {
		rememberPreviewProof(version, proof)
	}
	if p.IfVersion != "" && p.IfVersion == version {
		return previewResult{Kind: "notModified", Version: version}, nil
	}
	return previewResult{
		Kind: "ok", Base64: base64.StdEncoding.EncodeToString(buf), Size: before.Size(), Version: version,
	}, nil
}

func readPreviewRange(file *os.File, offset, length int64) ([]byte, error) {
	if length == 0 {
		return nil, nil
	}
	buf := make([]byte, length)
	n, err := file.ReadAt(buf, offset)
	if n != len(buf) && (err == nil || err == io.EOF) {
		return nil, FSError{Code: CodeStale, Path: file.Name()}
	}
	return buf, err
}

func readProvenPreviewRange(file *os.File, size, offset, length int64, proof []previewDigest) ([]byte, error) {
	first := offset / previewProofBlockBytes
	end := (offset + length + previewProofBlockBytes - 1) / previewProofBlockBytes
	startByte := first * previewProofBlockBytes
	buf, err := readPreviewRange(file, startByte, min(size, end*previewProofBlockBytes)-startByte)
	if err != nil {
		return nil, err
	}
	for block := first; block < end; block++ {
		start := (block - first) * previewProofBlockBytes
		digest := sha256.Sum256(buf[start:min(start+previewProofBlockBytes, int64(len(buf)))])
		if digest != proof[block] {
			return nil, FSError{Code: CodeStale, Path: file.Name()}
		}
	}
	start := offset - startByte
	return buf[start : start+length], nil
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
