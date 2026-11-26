package fs

import (
	"encoding/json"
	"path/filepath"
	"runtime"

	"github.com/nexus-code/nexus-code/internal/proto"
)

type params struct {
	RelPath string `json:"relPath"`
}

func (s *Service) Resolve(relPath string) (string, error) {
	if relPath == "" {
		relPath = "."
	}
	abs := filepath.Clean(filepath.Join(s.root, relPath))
	rel, err := filepath.Rel(s.root, abs)
	if err != nil {
		return "", err
	}
	if rel == "" || rel == "." {
		return abs, nil
	}
	if hasDotDotPrefix(rel) || filepath.IsAbs(rel) {
		return "", FSError{Code: CodeOutOfWorkspace, Path: relPath}
	}
	return abs, nil
}

func (s *Service) resolve(raw json.RawMessage) (string, error) {
	var envelope map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &envelope) != nil {
		return "", proto.ProtocolError("fs method params must include relPath")
	}
	relRaw, ok := envelope["relPath"]
	if !ok {
		return "", proto.ProtocolError("fs method params must include relPath")
	}
	var p params
	if json.Unmarshal(relRaw, &p.RelPath) != nil {
		return "", proto.ProtocolError("fs method params must include relPath")
	}
	return s.Resolve(p.RelPath)
}

func parseAbsolutePath(raw json.RawMessage) (string, error) {
	var p ReadAbsoluteParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil || p.AbsolutePath == "" {
		return "", proto.ProtocolError("fs.readAbsolute params must include absolutePath")
	}
	if refusesDeviceVolume(p.AbsolutePath) {
		return "", FSError{Code: CodeNotFound, Path: "device paths are not read: " + p.AbsolutePath}
	}
	if !filepath.IsAbs(p.AbsolutePath) {
		return "", FSError{Code: CodeNotFound, Path: "path must be absolute: " + p.AbsolutePath}
	}
	clean := filepath.Clean(p.AbsolutePath)
	if refusesDeviceVolume(clean) {
		return "", FSError{Code: CodeNotFound, Path: "device paths are not read: " + p.AbsolutePath}
	}
	return clean, nil
}

type windowsPathKind string

const (
	windowsDevicePath   windowsPathKind = "device"
	windowsUNCPath      windowsPathKind = "unc"
	windowsDrivePath    windowsPathKind = "drive"
	windowsRootedPath   windowsPathKind = "rooted"
	windowsRelativePath windowsPathKind = "relative"
)

func classifyWindowsPath(path string) windowsPathKind {
	sep := func(i int) bool { return i < len(path) && (path[i] == '\\' || path[i] == '/') }
	ends := func(i int) bool { return i == len(path) || sep(i) }
	switch {
	case sep(0) && sep(1) && len(path) > 2 && (path[2] == '?' || path[2] == '.') && ends(3):
		return windowsDevicePath
	case sep(0) && len(path) > 2 && path[1] == '?' && path[2] == '?' && ends(3):
		return windowsDevicePath
	case sep(0) && sep(1):
		return windowsUNCPath
	case len(path) > 2 && isDriveLetter(path[0]) && path[1] == ':' && sep(2):
		return windowsDrivePath
	case sep(0):
		return windowsRootedPath
	}
	return windowsRelativePath
}

func isDriveLetter(c byte) bool {
	return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z'
}

func refusesDeviceVolume(path string) bool {
	return runtime.GOOS == "windows" && classifyWindowsPath(path) == windowsDevicePath
}

func hasDotDotPrefix(rel string) bool {
	return rel == ".." || len(rel) > 3 && rel[:3] == ".."+string(filepath.Separator)
}
