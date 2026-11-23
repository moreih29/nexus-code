package lsp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const loginShellTimeout = 5 * time.Second

const rustupWhichTimeout = 10 * time.Second

const loginPathMarker = "__NEXUS_LOGIN_PATH__"

type FindBinaryParams struct {
	Name                 string `json:"name"`
	Path                 string `json:"path,omitempty"`
	SearchPath           string `json:"searchPath,omitempty"`
	Dir                  string `json:"dir,omitempty"`
	ExcludeAgentWrappers bool   `json:"excludeAgentWrappers,omitempty"`
}

type FindBinaryResult struct {
	Path    string `json:"path"`
	EnvPath string `json:"envPath,omitempty"`
}

func (s *Service) FindBinary(_ context.Context, raw json.RawMessage) (any, error) {
	var p FindBinaryParams
	if err := proto.DecodeParams(raw, &p, "lsp.findBinary params must include name"); err != nil {
		return nil, err
	}
	if p.Name == "" || strings.ContainsAny(p.Name, `/\`+"\x00") {
		return nil, proto.ProtocolError("lsp.findBinary name must be a command name")
	}

	home, _ := os.UserHomeDir()
	shellPath := loginShellPath()
	var preferred []string
	for _, dir := range filepath.SplitList(p.SearchPath) {
		dir = expandHome(dir, home)
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(p.Dir, dir)
		}
		preferred = append(preferred, dir)
	}
	dirs := append(preferred, searchDirs(home, shellPath)...)
	path := findBinary(p.Name, expandHome(strings.TrimSpace(p.Path), home), p.Dir, dirs)
	if path == "" {
		return FindBinaryResult{}, nil
	}
	lists := append([]string{filepath.Dir(path), shellPath, os.Getenv("PATH")}, dirs...)
	envPath := joinPathLists(lists...)
	if p.ExcludeAgentWrappers {
		envPath = withoutAgentWrappers(envPath)
	}
	return FindBinaryResult{Path: path, EnvPath: envPath}, nil
}

func withoutAgentWrappers(pathList string) string {
	var clean []string
	for _, dir := range filepath.SplitList(pathList) {
		if filepath.IsAbs(dir) && !hasAgentWrapper(dir) {
			clean = append(clean, dir)
		}
	}
	return strings.Join(clean, string(os.PathListSeparator))
}

func hasAgentWrapper(dir string) bool {
	for _, name := range []string{"claude", "codex"} {
		for _, file := range append(executableNames(filepath.Join(dir, name)), filepath.Join(dir, name+".cmd")) {
			if isAgentWrapper(name, file) {
				return true
			}
		}
	}
	return false
}

func findBinary(name, userPath, workDir string, dirs []string) string {
	if userPath != "" {
		for _, candidate := range executableNames(userPath) {
			if canRunServer(candidate, workDir) && !isAgentWrapper(name, candidate) {
				return candidate
			}
		}
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for _, candidate := range executableNames(filepath.Join(dir, name)) {
			if canRunServer(candidate, workDir) && !isAgentWrapper(name, candidate) {
				return candidate
			}
		}
	}
	return ""
}

func isAgentWrapper(name, path string) bool {
	if name != "claude" && name != "codex" {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	var header [512]byte
	n, _ := file.Read(header[:])
	return bytes.Contains(header[:n], []byte("nexus-code "+name+" wrapper")) ||
		bytes.Contains(header[:n], []byte("cmux claude wrapper"))
}

func canRunServer(path, workDir string) bool {
	return isExecutableFile(path) && !isRustupProxyWithoutTool(path, workDir)
}

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
	var exitErr *exec.ExitError
	return ctx.Err() == nil && errors.As(err, &exitErr)
}

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
	cmd := exec.CommandContext(ctx, shell, "-ilc", `printf '%s%s' "`+loginPathMarker+`" "$PATH"`)
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	_, path, _ := strings.Cut(string(out), loginPathMarker)
	return strings.TrimSpace(path)
}
