package fs

import (
	"encoding/json"
	"path/filepath"

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
	if !filepath.IsAbs(p.AbsolutePath) {
		return "", FSError{Code: CodeNotFound, Path: "path must be absolute: " + p.AbsolutePath}
	}
	return filepath.Clean(p.AbsolutePath), nil
}

func hasDotDotPrefix(rel string) bool {
	return rel == ".." || len(rel) > 3 && rel[:3] == ".."+string(filepath.Separator)
}
