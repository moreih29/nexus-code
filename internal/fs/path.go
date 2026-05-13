package fs

import (
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// params is the shared "single relPath" envelope shape used by readdir / stat
// / readFile. Write methods declare richer payloads in types.go.
type params struct {
	RelPath string `json:"relPath"`
}

// Resolve joins relPath against the workspace root and returns the cleaned
// absolute path. Refuses anything that escapes the root via `..` or an absolute
// path.
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
	if strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", FSError{Code: CodeOutOfWorkspace, Path: relPath}
	}
	return abs, nil
}

// resolve unmarshals the shared {relPath} params envelope and delegates to
// Resolve. Used by readdir / stat / readFile.
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

// parseAbsolutePath unmarshals the {absolutePath} envelope used by
// fs.readAbsolute. The path is not constrained to the workspace root, but it
// must already be absolute on the agent host.
func parseAbsolutePath(raw json.RawMessage) (string, error) {
	var p ReadAbsoluteParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil || p.AbsolutePath == "" {
		return "", proto.ProtocolError("fs.readAbsolute params must include absolutePath")
	}
	if !filepath.IsAbs(p.AbsolutePath) {
		return "", FSError{Code: CodeNotFound, Path: "path must be absolute: " + p.AbsolutePath}
	}
	return filepath.Clean(p.AbsolutePath), nil
}
