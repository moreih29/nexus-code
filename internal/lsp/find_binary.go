package lsp

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// The servers the app does not bundle, such as gopls and rust-analyzer, are
// found on the host the agent runs on, local or remote: where the user said,
// on the PATH, on the PATH a login shell sets up, then where their installers
// put them. A GUI app and an SSH session both start with less on the PATH
// than the user's terminal has; `go install` puts gopls in ~/go/bin, which
// the PATH often leaves out.

const loginShellTimeout = 5 * time.Second

// loginPathMarker sets the PATH apart from whatever the shell's startup
// files print.
const loginPathMarker = "__NEXUS_LOGIN_PATH__"

type FindBinaryParams struct {
	// Name is the command to find, such as "gopls".
	Name string `json:"name"`
	// Path is where the user said it is, "~" standing for their home. It is
	// tried first; when nothing is there the search goes on.
	Path string `json:"path,omitempty"`
}

type FindBinaryResult struct {
	// Path is the binary found, empty when none was.
	Path string `json:"path"`
	// EnvPath is a PATH for the server: the binary's directory, then the
	// login shell's PATH and the agent's own. gopls runs go, and
	// rust-analyzer cargo.
	EnvPath string `json:"envPath,omitempty"`
}

func (s *Service) FindBinary(_ context.Context, raw json.RawMessage) (any, error) {
	var p FindBinaryParams
	if err := decodeParams(raw, &p, "lsp.findBinary params must include name"); err != nil {
		return nil, err
	}
	if p.Name == "" || strings.ContainsAny(p.Name, `/\`+"\x00") {
		return nil, protocolError("lsp.findBinary name must be a command name")
	}

	home, _ := os.UserHomeDir()
	shellPath := loginShellPath()
	path := findBinary(p.Name, expandHome(strings.TrimSpace(p.Path), home), searchDirs(home, shellPath))
	if path == "" {
		return FindBinaryResult{}, nil
	}
	return FindBinaryResult{
		Path:    path,
		EnvPath: joinPathLists(filepath.Dir(path), shellPath, os.Getenv("PATH")),
	}, nil
}

func findBinary(name, userPath string, dirs []string) string {
	if userPath != "" && isExecutableFile(userPath) {
		return userPath
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for _, candidate := range executableNames(filepath.Join(dir, name)) {
			if isExecutableFile(candidate) {
				return candidate
			}
		}
	}
	return ""
}

// searchDirs lists where to look, in order.
func searchDirs(home, shellPath string) []string {
	dirs := filepath.SplitList(os.Getenv("PATH"))
	dirs = append(dirs, filepath.SplitList(shellPath)...)
	if gobin := os.Getenv("GOBIN"); gobin != "" {
		dirs = append(dirs, gobin)
	}
	for _, gopath := range filepath.SplitList(os.Getenv("GOPATH")) {
		dirs = append(dirs, filepath.Join(gopath, "bin"))
	}
	if home != "" {
		dirs = append(dirs,
			filepath.Join(home, "go", "bin"),
			filepath.Join(home, ".cargo", "bin"),
			filepath.Join(home, ".local", "bin"),
		)
	}
	if runtime.GOOS != "windows" {
		dirs = append(dirs,
			"/usr/local/go/bin",
			"/usr/local/bin",
			"/opt/homebrew/bin",
			"/home/linuxbrew/.linuxbrew/bin",
		)
	}
	return dirs
}

func executableNames(path string) []string {
	if runtime.GOOS == "windows" && filepath.Ext(path) == "" {
		return []string{path + ".exe", path}
	}
	return []string{path}
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0
}

func expandHome(path, home string) string {
	if home == "" {
		return path
	}
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		return filepath.Join(home, path[2:])
	}
	return path
}

// joinPathLists joins PATH lists, each directory once, in order.
func joinPathLists(lists ...string) string {
	seen := map[string]bool{}
	var dirs []string
	for _, list := range lists {
		for _, dir := range filepath.SplitList(list) {
			if dir != "" && !seen[dir] {
				seen[dir] = true
				dirs = append(dirs, dir)
			}
		}
	}
	return strings.Join(dirs, string(os.PathListSeparator))
}

var (
	loginPathOnce sync.Once
	loginPath     string
)

// loginShellPath is the PATH the user's login shell sets up, asked once;
// empty on Windows, which has none, and when the shell fails or takes too
// long.
func loginShellPath() string {
	if runtime.GOOS == "windows" {
		return ""
	}
	loginPathOnce.Do(func() {
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "/bin/sh"
		}
		ctx, cancel := context.WithTimeout(context.Background(), loginShellTimeout)
		defer cancel()
		// -i too: many put their PATH in .zshrc or .bashrc.
		cmd := exec.CommandContext(ctx, shell, "-ilc", `printf '%s%s' "`+loginPathMarker+`" "$PATH"`)
		// A process the startup files left running can hold the output open.
		cmd.WaitDelay = time.Second
		out, err := cmd.Output()
		if err != nil {
			return
		}
		if _, path, ok := strings.Cut(string(out), loginPathMarker); ok {
			loginPath = strings.TrimSpace(path)
		}
	})
	return loginPath
}
