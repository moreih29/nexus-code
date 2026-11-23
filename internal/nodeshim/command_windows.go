//go:build windows

package nodeshim

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const shimReadMax = 8 << 10

func Command(path string, args ...string) *exec.Cmd {
	if node, script, nodeArgs, ok := nodeShim(path); ok {
		return exec.Command(node, append(append(nodeArgs, script), args...)...)
	}
	return exec.Command(path, args...)
}

func nodeShim(path string) (node, script string, nodeArgs []string, ok bool) {
	candidates := []string{path}
	if filepath.Ext(path) == "" {
		candidates = append(candidates, path+".cmd")
	} else if ext := strings.ToLower(filepath.Ext(path)); ext == ".cmd" || ext == ".bat" {
		candidates = append(candidates, strings.TrimSuffix(path, filepath.Ext(path)))
	}
	for _, candidate := range candidates {
		content, err := readHead(candidate, shimReadMax)
		if err != nil {
			continue
		}
		script, nodeArgs, ok = shimOf(candidate, content)
		if !ok || !isFile(script) {
			continue
		}
		node = filepath.Join(filepath.Dir(candidate), "node.exe")
		if !isFile(node) {
			if node, err = exec.LookPath("node"); err != nil {
				return "", "", nil, false
			}
		}
		return node, script, nodeArgs, true
	}
	return "", "", nil, false
}

func readHead(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, max))
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
