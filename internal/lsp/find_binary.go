package lsp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// The servers the app does not bundle, such as gopls and rust-analyzer, are
// found on the host the agent runs on, local or remote: where the user said,
// on the PATH, on the PATH a login shell sets up, then where their installers
// put them. A GUI app and an SSH session both start with less on the PATH
// than the user's terminal has; `go install` puts gopls in ~/go/bin, which
// the PATH often leaves out.

const loginShellTimeout = 5 * time.Second

// rustupWhichTimeout bounds asking rustup whether a toolchain has a tool.
const rustupWhichTimeout = 10 * time.Second

// loginPathMarker sets the PATH apart from whatever the shell's startup
// files print.
const loginPathMarker = "__NEXUS_LOGIN_PATH__"

type FindBinaryParams struct {
	// Name is the command to find, such as "gopls".
	Name string `json:"name"`
	// Path is where the user said it is, "~" standing for their home. It is
	// tried first; when nothing is there the search goes on.
	Path string `json:"path,omitempty"`
	// Dir is where the server will run, the workspace root. A rustup proxy
	// picks its toolchain there.
	Dir string `json:"dir,omitempty"`
}

type FindBinaryResult struct {
	// Path is the binary found, empty when none was.
	Path string `json:"path"`
	// EnvPath is a PATH for the server: the binary's directory, the login
	// shell's PATH and the agent's own, then where installers put tools.
	// gopls runs go, and rust-analyzer cargo.
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
	dirs := searchDirs(home, shellPath)
	path := findBinary(p.Name, expandHome(strings.TrimSpace(p.Path), home), p.Dir, dirs)
	if path == "" {
		return FindBinaryResult{}, nil
	}
	// The install directories last: go in /usr/local/go/bin is missed by a
	// PATH no login shell gave, as a GUI app's is when the shell fails.
	lists := append([]string{filepath.Dir(path), shellPath, os.Getenv("PATH")}, dirs...)
	return FindBinaryResult{Path: path, EnvPath: joinPathLists(lists...)}, nil
}

func findBinary(name, userPath, workDir string, dirs []string) string {
	if userPath != "" {
		// On Windows "gopls" stands for "gopls.exe", as in a shell.
		for _, candidate := range executableNames(userPath) {
			if canRunServer(candidate, workDir) {
				return candidate
			}
		}
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for _, candidate := range executableNames(filepath.Join(dir, name)) {
			if canRunServer(candidate, workDir) {
				return candidate
			}
		}
	}
	return ""
}

func canRunServer(path, workDir string) bool {
	return isExecutableFile(path) && !isRustupProxyWithoutTool(path, workDir)
}

// isRustupProxyWithoutTool reports whether path is a rustup proxy whose
// toolchain lacks the tool. ~/.cargo/bin/rust-analyzer is rustup itself
// under the tool's name, there whether the rust-analyzer component is or
// not; without it the proxy prints an error and exits, and the user would
// be told the server keeps failing, not that it is missing and how to add
// it. rustup picks the toolchain by the directory it runs in, as the server
// will in workDir.
func isRustupProxyWithoutTool(path, workDir string) bool {
	rustup := rustupOf(path)
	if rustup == "" {
		return false
	}
	tool := filepath.Base(path)
	if runtime.GOOS == "windows" {
		tool = strings.TrimSuffix(tool, ".exe")
	}
	ctx, cancel := context.WithTimeout(context.Background(), rustupWhichTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, rustup, "which", tool)
	cmd.Dir = workDir
	err := cmd.Run()
	// Only rustup's own no counts: a rustup that does not start or answer in
	// time leaves the proxy to the server's start, as before.
	var exitErr *exec.ExitError
	return ctx.Err() == nil && errors.As(err, &exitErr)
}

// rustupOf returns the rustup beside path when path is a link of it, as
// rustup's proxies are; empty otherwise.
func rustupOf(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	for _, rustup := range executableNames(filepath.Join(filepath.Dir(path), "rustup")) {
		if other, err := os.Stat(rustup); err == nil && os.SameFile(info, other) {
			return rustup
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

// loginShellPath is the PATH the user's login shell sets up; empty on
// Windows, which has none, and when the shell fails or takes too long.
//
// It is asked each time a server is looked for, not once per agent: an
// agent on a remote host outlives the app, and the user told a server is
// missing installs it, sets up its PATH and starts it again.
func loginShellPath() string {
	if runtime.GOOS == "windows" {
		return ""
	}
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
		return ""
	}
	_, path, _ := strings.Cut(string(out), loginPathMarker)
	return strings.TrimSpace(path)
}
