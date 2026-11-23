package git

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/nexus-code/nexus-code/internal/proto"
)

type InfoResult struct {
	BinaryPath    string `json:"binaryPath"`
	BinaryVersion string `json:"binaryVersion"`
}

func (s *Service) Info(ctx context.Context, raw json.RawMessage) (any, error) {
	path, version, err := resolveSystemGit(ctx)
	if err != nil || path == "" {
		return nil, nil
	}
	return InfoResult{BinaryPath: path, BinaryVersion: version}, nil
}

func resolveSystemGit(ctx context.Context) (string, string, error) {
	candidates := gitCandidates()
	for _, candidate := range candidates {
		path, version, ok := inspectGitCandidate(ctx, candidate)
		if ok {
			return path, version, nil
		}
	}
	return "", "", nil
}

func gitCandidates() []string {
	seen := make(map[string]struct{})
	var out []string

	add := func(p string) {
		if p == "" {
			return
		}
		if _, exists := seen[p]; exists {
			return
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}

	if found, err := exec.LookPath("git"); err == nil {
		add(found)
	}

	for _, p := range gitInstallPaths(runtime.GOOS, os.Getenv) {
		add(p)
	}

	if runtime.GOOS != "windows" {
		add("/usr/bin/git")
	}

	return out
}

func inspectGitCandidate(ctx context.Context, candidate string) (string, string, bool) {
	abs, err := filepath.Abs(candidate)
	if err != nil {
		abs = candidate
	}

	cmd := exec.CommandContext(ctx, abs, "--version")
	cmd.Env = append(cmd.Environ(), "GIT_TERMINAL_PROMPT=0")
	stdout := cappedBuffer{cap: defaultStdoutCapBytes}
	cmd.Stdout = &stdout
	cmd.WaitDelay = time.Second
	if err := runGitProbe(ctx, runtime.GOOS, cmd, (*exec.Cmd).Run); stdout.overflow || err != nil && !errors.Is(err, exec.ErrWaitDelay) {
		return "", "", false
	}

	version := parseGitVersionOutput(stdout.String())
	if version == "" {
		return "", "", false
	}
	return abs, version, true
}

func parseGitVersionOutput(output string) string {
	line := strings.TrimSpace(output)
	if idx := strings.IndexAny(line, "\r\n"); idx >= 0 {
		line = line[:idx]
	}
	const prefix = "git version "
	if !strings.HasPrefix(strings.ToLower(line), prefix) {
		return ""
	}
	version := strings.TrimSpace(line[len(prefix):])
	return version
}

type DetectParams struct {
	Cwd string `json:"cwd"`
}

type DetectResult struct {
	Kind     string `json:"kind"`
	TopLevel string `json:"topLevel,omitempty"`
	GitDir   string `json:"gitDir,omitempty"`
}

func (s *Service) Detect(ctx context.Context, raw json.RawMessage) (any, error) {
	var p DetectParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil || strings.TrimSpace(p.Cwd) == "" {
		return nil, proto.ProtocolError("git.detect params must include cwd")
	}

	topLevel, gitDir, err := runRevParse(ctx, p.Cwd)
	if errors.Is(err, exec.ErrNotFound) {
		return DetectResult{Kind: "git-missing"}, nil
	}
	if err != nil {
		return DetectResult{Kind: "non-repo"}, nil
	}

	return DetectResult{
		Kind:     "repo",
		TopLevel: topLevel,
		GitDir:   gitDir,
	}, nil
}

func runRevParse(ctx context.Context, cwd string) (topLevel, gitDir string, err error) {
	cmd := exec.CommandContext(ctx, gitBinary(), "rev-parse", "--show-toplevel", "--git-dir", "--show-cdup")
	cmd.Dir = cwd
	cmd.Env = append(cmd.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=echo",
		"SSH_ASKPASS_REQUIRE=force",
		"SSH_ASKPASS=echo",
		"GIT_FLUSH=1",
	)
	cmd.Env = withSafeGitConfig(cmd.Env)

	stdout := cappedBuffer{cap: defaultStdoutCapBytes}
	var stderr gitStderr
	cmd.Stdout = &stdout
	cmd.WaitDelay = time.Second
	cmd.Stderr = &stderr

	runErr := runGitProbe(ctx, runtime.GOOS, cmd, (*exec.Cmd).Run)
	if stdout.overflow {
		return "", "", outputLimitFailure(defaultStdoutCapBytes)
	}
	if runErr != nil && !errors.Is(runErr, exec.ErrWaitDelay) {
		return "", "", runErr
	}

	lines := parseRevParseLines(stdout.String())
	if len(lines) < 2 || lines[0] == "" || lines[1] == "" {
		return "", "", proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  "git rev-parse did not return repository paths",
		}
	}

	cdup := ""
	if len(lines) > 2 {
		cdup = lines[2]
	}
	tl := normalizeDetectedPath(cwd, lines[0])
	gd := normalizeDetectedPath(cwd, lines[1])
	logical := logicalTopLevel(cwd, cdup, tl)
	return logical, rebasePath(gd, tl, logical), nil
}

func runGitProbe(ctx context.Context, goos string, cmd *exec.Cmd, run func(*exec.Cmd) error) error {
	if cmd.Err != nil {
		return cmd.Err
	}
	if goos == "darwin" {
		const appleGit = "/usr/bin/git"
		candidate := path.Clean(filepath.ToSlash(cmd.Path))
		if candidate != appleGit {
			if resolved, err := filepath.EvalSymlinks(cmd.Path); err == nil {
				candidate = path.Clean(filepath.ToSlash(resolved))
			}
		}
		if candidate == appleGit {
			probe := exec.CommandContext(ctx, "/usr/bin/xcode-select", "--print-path")
			probe.Env = cmd.Environ()
			if err := run(probe); err != nil {
				var exit *exec.ExitError
				if ctx.Err() == nil && errors.As(err, &exit) {
					return exec.ErrNotFound
				}
				return err
			}
		}
	}
	return run(cmd)
}

func logicalTopLevel(cwd, cdup, topLevel string) string {
	if !filepath.IsAbs(cwd) {
		return topLevel
	}
	candidate := filepath.Clean(filepath.Join(cwd, cdup))
	if candidate == topLevel {
		return topLevel
	}
	resolvedCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return topLevel
	}
	resolvedTopLevel, err := filepath.EvalSymlinks(topLevel)
	if err != nil || resolvedCandidate != resolvedTopLevel {
		return topLevel
	}
	return candidate
}

func rebasePath(path, from, to string) string {
	rel, err := filepath.Rel(from, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return path
	}
	return filepath.Join(to, rel)
}

func parseRevParseLines(output string) []string {
	output = strings.TrimRight(output, "\r\n")
	parts := strings.Split(output, "\n")
	for i, p := range parts {
		parts[i] = strings.TrimRight(p, "\r")
	}
	return parts
}

func normalizeDetectedPath(cwd, value string) string {
	value = strings.TrimRight(value, "\r")
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	return filepath.Clean(filepath.Join(cwd, value))
}
