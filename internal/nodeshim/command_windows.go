//go:build windows

package nodeshim

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// shimReadMax is as much of a command as is read to tell a node shim.
const shimReadMax = 8 << 10

// Command runs the program at `path`, as found on PATH. A node package's
// command runs as node on its script: the .cmd Windows would run instead
// passes the arguments through cmd.exe, which ends a prompt at its first
// line and expands its %VARS%, and the sh script through Git Bash, which
// splits them.
func Command(path string, args ...string) *exec.Cmd {
	if node, script, nodeArgs, ok := nodeShim(path); ok {
		return exec.Command(node, append(append(nodeArgs, script), args...)...)
	}
	return exec.Command(path, args...)
}

// nodeShim is node and the script the command at `path` runs, when it is a
// node shim: the sh script at that path, or the .cmd beside it.
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
		// The node beside the shim, as the shim runs it, else node on PATH.
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
