package git

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// ---------------------------------------------------------------------------
// git.info — system git binary path and version
// ---------------------------------------------------------------------------

// InfoResult carries the resolved git binary path and version string.
type InfoResult struct {
	BinaryPath    string `json:"binaryPath"`
	BinaryVersion string `json:"binaryVersion"`
}

// Info resolves the system git binary path and version and returns them.
// Returns null (nil, nil) when git is absent — the TS side maps nil to null.
func (s *Service) Info(ctx context.Context, raw json.RawMessage) (any, error) {
	path, version, err := resolveSystemGit(ctx)
	if err != nil || path == "" {
		// Absent git is not a protocol error — return null so TS maps it to null.
		return nil, nil
	}
	return InfoResult{BinaryPath: path, BinaryVersion: version}, nil
}

// resolveSystemGit locates the git binary on PATH and returns its path and
// version string. Returns ("", "", nil) when git cannot be found.
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

// gitCandidates returns a de-duplicated ordered list of paths to probe.
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

	// Prefer PATH-located git first.
	if found, err := exec.LookPath("git"); err == nil {
		add(found)
	}

	// Unix fallback.
	if runtime.GOOS != "windows" {
		add("/usr/bin/git")
	}

	return out
}

// inspectGitCandidate runs `git --version` on the candidate and parses the
// output. Returns ("", "", false) when the candidate fails.
func inspectGitCandidate(ctx context.Context, candidate string) (string, string, bool) {
	abs, err := filepath.Abs(candidate)
	if err != nil {
		abs = candidate
	}

	cmd := exec.CommandContext(ctx, abs, "--version")
	cmd.Env = append(cmd.Environ(), "GIT_TERMINAL_PROMPT=0")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return "", "", false
	}

	version := parseGitVersionOutput(stdout.String())
	if version == "" {
		return "", "", false
	}
	return abs, version, true
}

// parseGitVersionOutput extracts the version token from `git --version` output.
func parseGitVersionOutput(output string) string {
	line := strings.TrimSpace(output)
	// Take only the first line in case of multi-line output.
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

// ---------------------------------------------------------------------------
// git.detect — repository detection for a workspace root
// ---------------------------------------------------------------------------

// DetectParams carries the workspace directory to probe.
type DetectParams struct {
	Cwd string `json:"cwd"`
}

// DetectResult mirrors src/shared/types/git.ts RepoInfoSchema for the repo case.
// Non-repo and error cases return the non-repo variant.
type DetectResult struct {
	Kind     string `json:"kind"`
	TopLevel string `json:"topLevel,omitempty"`
	GitDir   string `json:"gitDir,omitempty"`
}

// Detect runs `git rev-parse --show-toplevel --git-dir` in the given cwd and
// returns a RepoInfo-compatible object, its paths in cwd's path space (see
// logicalTopLevel). Non-repository directories return { kind: "non-repo" }
// rather than an error.
func (s *Service) Detect(ctx context.Context, raw json.RawMessage) (any, error) {
	var p DetectParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil || strings.TrimSpace(p.Cwd) == "" {
		return nil, proto.ProtocolError("git.detect params must include cwd")
	}

	topLevel, gitDir, err := runRevParse(ctx, p.Cwd)
	if err != nil {
		// Any git error (including "not a git repository") maps to non-repo.
		return DetectResult{Kind: "non-repo"}, nil
	}

	return DetectResult{
		Kind:     "repo",
		TopLevel: topLevel,
		GitDir:   gitDir,
	}, nil
}

// runRevParse executes `git rev-parse --show-toplevel --git-dir --show-cdup`
// in cwd. Returns the absolute toplevel and gitdir paths on success, reached
// from cwd by the path cwd was given in (see logicalTopLevel).
func runRevParse(ctx context.Context, cwd string) (topLevel, gitDir string, err error) {
	cmd := exec.CommandContext(ctx, "git", "rev-parse", "--show-toplevel", "--git-dir", "--show-cdup")
	cmd.Dir = cwd
	cmd.Env = append(cmd.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=echo",
		"SSH_ASKPASS_REQUIRE=force",
		"SSH_ASKPASS=echo",
		"GIT_FLUSH=1",
	)
	cmd.Env = withSafeGitConfig(cmd.Env)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if runErr := cmd.Run(); runErr != nil {
		return "", "", runErr
	}

	lines := parseRevParseLines(stdout.String())
	if len(lines) < 2 || lines[0] == "" || lines[1] == "" {
		return "", "", proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  "git rev-parse did not return repository paths",
		}
	}

	// --show-cdup prints an empty line at the top level, which the trailing
	// newline trim drops.
	cdup := ""
	if len(lines) > 2 {
		cdup = lines[2]
	}
	tl := normalizeDetectedPath(cwd, lines[0])
	gd := normalizeDetectedPath(cwd, lines[1])
	logical := logicalTopLevel(cwd, cdup, tl)
	return logical, rebasePath(gd, tl, logical), nil
}

// logicalTopLevel returns the repository root git reports — with symlinks
// resolved, so /private/tmp/repo on macOS for a workspace opened at /tmp/repo
// — as reached from cwd by the path cwd was given in: /tmp/repo. Workspace
// file paths are built from that path, so a root that spells it differently
// can neither be stripped from nor joined onto them. cdup is
// `git rev-parse --show-cdup` run in cwd.
//
// Falls back to git's root when walking up from cwd does not land on the same
// directory, as for a workspace that is a symlink into the middle of a tree.
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

// rebasePath moves path from under root `from` to the same place under `to`.
// Paths outside `from` are returned unchanged.
func rebasePath(path, from, to string) string {
	rel, err := filepath.Rel(from, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return path
	}
	return filepath.Join(to, rel)
}

// parseRevParseLines splits the two-line rev-parse output, stripping the
// trailing newline that git always appends. Each line is also stripped of
// any trailing carriage return so Windows CRLF output is handled correctly.
func parseRevParseLines(output string) []string {
	// Strip trailing newlines before splitting.
	output = strings.TrimRight(output, "\r\n")
	parts := strings.Split(output, "\n")
	for i, p := range parts {
		parts[i] = strings.TrimRight(p, "\r")
	}
	return parts
}

// normalizeDetectedPath converts a possibly-relative git path to an absolute
// path anchored at cwd. Git emits relative paths for some repo shapes (e.g.
// bare repos or nested worktrees).
func normalizeDetectedPath(cwd, value string) string {
	value = strings.TrimRight(value, "\r")
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	return filepath.Clean(filepath.Join(cwd, value))
}
