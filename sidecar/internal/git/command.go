package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"

	"nexus-code/sidecar/internal/contracts"
)

const DefaultGitPath = "git"

var ErrNoPaths = errors.New("at least one git path is required")

type Client interface {
	Status(context.Context, string) (contracts.GitStatusSummary, error)
	BranchList(context.Context, string) ([]contracts.GitBranch, error)
	Commit(context.Context, string, string, bool) (string, error)
	Stage(context.Context, string, []string) error
	Unstage(context.Context, string, []string) error
	Discard(context.Context, string, []string) error
	Checkout(context.Context, string, string) error
	BranchCreate(context.Context, string, string, *string) error
	BranchDelete(context.Context, string, string, bool) error
	Diff(context.Context, string, bool, []string) (string, error)
}

type CLI struct {
	gitPath string
	runner  Runner
}

type Runner interface {
	Run(context.Context, string, string, []string) (CommandResult, error)
}

type RunnerFunc func(context.Context, string, string, []string) (CommandResult, error)

func (f RunnerFunc) Run(ctx context.Context, cwd string, gitPath string, args []string) (CommandResult, error) {
	return f(ctx, cwd, gitPath, args)
}

type CommandResult struct {
	Stdout   string
	Stderr   string
	ExitCode *int
}

type CommandError struct {
	Args     []string
	Stderr   string
	ExitCode *int
	Err      error
}

func (e *CommandError) Error() string {
	if e == nil {
		return ""
	}
	if strings.TrimSpace(e.Stderr) != "" {
		return strings.TrimSpace(e.Stderr)
	}
	if e.Err != nil {
		return e.Err.Error()
	}
	return fmt.Sprintf("git %s failed", strings.Join(e.Args, " "))
}

func (e *CommandError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func NewCLI() *CLI {
	return NewCLIWithRunner(DefaultGitPath, ExecRunner{})
}

func NewCLIWithRunner(gitPath string, runner Runner) *CLI {
	if strings.TrimSpace(gitPath) == "" {
		gitPath = DefaultGitPath
	}
	if runner == nil {
		runner = ExecRunner{}
	}
	return &CLI{gitPath: gitPath, runner: runner}
}

type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, cwd string, gitPath string, args []string) (CommandResult, error) {
	cmd := exec.CommandContext(ctx, gitPath, args...)
	cmd.Dir = cwd
	cmd.Env = os.Environ()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	result := CommandResult{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}
	if cmd.ProcessState != nil {
		code := cmd.ProcessState.ExitCode()
		result.ExitCode = &code
	}
	if err != nil {
		return result, &CommandError{
			Args:     append([]string(nil), args...),
			Stderr:   result.Stderr,
			ExitCode: result.ExitCode,
			Err:      err,
		}
	}
	return result, nil
}

func (c *CLI) Status(ctx context.Context, cwd string) (contracts.GitStatusSummary, error) {
	result, err := c.run(ctx, cwd, "status", "--porcelain=v1", "-b", "--untracked-files=all")
	if err != nil {
		return contracts.GitStatusSummary{}, err
	}
	return ParseStatus(result.Stdout), nil
}

func (c *CLI) BranchList(ctx context.Context, cwd string) ([]contracts.GitBranch, error) {
	result, err := c.run(ctx, cwd, "branch", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(objectname)")
	if err != nil {
		return nil, err
	}
	return ParseBranches(result.Stdout), nil
}

func (c *CLI) Commit(ctx context.Context, cwd string, message string, amend bool) (string, error) {
	args := []string{"commit", "-m", message}
	if amend {
		args = append(args, "--amend")
	}
	if _, err := c.run(ctx, cwd, args...); err != nil {
		return "", err
	}
	result, err := c.run(ctx, cwd, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(result.Stdout), nil
}

func (c *CLI) Stage(ctx context.Context, cwd string, paths []string) error {
	if len(paths) == 0 {
		return ErrNoPaths
	}
	_, err := c.run(ctx, cwd, appendPathspec([]string{"add"}, paths)...)
	return err
}

func (c *CLI) Unstage(ctx context.Context, cwd string, paths []string) error {
	if len(paths) == 0 {
		return ErrNoPaths
	}
	_, err := c.run(ctx, cwd, appendPathspec([]string{"restore", "--staged"}, paths)...)
	return err
}

func (c *CLI) Discard(ctx context.Context, cwd string, paths []string) error {
	if len(paths) == 0 {
		return ErrNoPaths
	}

	_, restoreErr := c.run(ctx, cwd, appendPathspec([]string{"restore", "--staged", "--worktree"}, paths)...)
	_, cleanErr := c.run(ctx, cwd, appendPathspec([]string{"clean", "-fd"}, paths)...)
	if cleanErr == nil {
		return nil
	}
	if restoreErr != nil {
		return fmt.Errorf("restore changes: %w; clean untracked: %w", restoreErr, cleanErr)
	}
	return cleanErr
}

func (c *CLI) Checkout(ctx context.Context, cwd string, ref string) error {
	_, err := c.run(ctx, cwd, "checkout", ref)
	return err
}

func (c *CLI) BranchCreate(ctx context.Context, cwd string, name string, startPoint *string) error {
	args := []string{"branch", name}
	if startPoint != nil && strings.TrimSpace(*startPoint) != "" {
		args = append(args, *startPoint)
	}
	_, err := c.run(ctx, cwd, args...)
	return err
}

func (c *CLI) BranchDelete(ctx context.Context, cwd string, name string, force bool) error {
	flag := "-d"
	if force {
		flag = "-D"
	}
	_, err := c.run(ctx, cwd, "branch", flag, name)
	return err
}

func (c *CLI) Diff(ctx context.Context, cwd string, staged bool, paths []string) (string, error) {
	args := []string{"diff", "--no-ext-diff"}
	if staged {
		args = append(args, "--cached")
	}
	args = appendPathspec(args, paths)
	result, err := c.run(ctx, cwd, args...)
	if err != nil {
		return "", err
	}
	return result.Stdout, nil
}

func (c *CLI) run(ctx context.Context, cwd string, args ...string) (CommandResult, error) {
	result, err := c.runner.Run(ctx, cwd, c.gitPath, append([]string(nil), args...))
	if err == nil {
		return result, nil
	}

	var commandErr *CommandError
	if errors.As(err, &commandErr) {
		return result, commandErr
	}
	return result, &CommandError{
		Args:     append([]string(nil), args...),
		Stderr:   result.Stderr,
		ExitCode: result.ExitCode,
		Err:      err,
	}
}

func appendPathspec(args []string, paths []string) []string {
	args = append(append([]string(nil), args...), "--")
	return append(args, paths...)
}

func ParseStatus(output string) contracts.GitStatusSummary {
	summary := contracts.GitStatusSummary{Files: []contracts.GitStatusEntry{}}
	for _, rawLine := range strings.Split(output, "\n") {
		line := strings.TrimRight(rawLine, "\r")
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "## ") {
			parseBranchHeader(line, &summary)
			continue
		}
		if entry, ok := parseStatusEntry(line); ok {
			summary.Files = append(summary.Files, entry)
		}
	}
	sort.Slice(summary.Files, func(i, j int) bool {
		return summary.Files[i].Path < summary.Files[j].Path
	})
	return summary
}

func ParseBranches(output string) []contracts.GitBranch {
	branches := []contracts.GitBranch{}
	for _, rawLine := range strings.Split(output, "\n") {
		line := strings.TrimRight(rawLine, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		for len(parts) < 4 {
			parts = append(parts, "")
		}
		name := strings.TrimSpace(parts[0])
		if name == "" {
			continue
		}
		branches = append(branches, contracts.GitBranch{
			Name:     name,
			Current:  strings.TrimSpace(parts[1]) == "*",
			Upstream: stringPtrOrNil(parts[2]),
			HeadOid:  stringPtrOrNil(parts[3]),
		})
	}
	sort.Slice(branches, func(i, j int) bool {
		if branches[i].Current != branches[j].Current {
			return branches[i].Current
		}
		return branches[i].Name < branches[j].Name
	})
	return branches
}

func parseBranchHeader(line string, summary *contracts.GitStatusSummary) {
	text := strings.TrimPrefix(line, "## ")
	if strings.HasPrefix(text, "No commits yet on ") {
		branch := strings.TrimSpace(strings.TrimPrefix(text, "No commits yet on "))
		if branch != "" {
			summary.Branch = &branch
		}
		return
	}

	var bracket string
	if index := strings.Index(text, " ["); index >= 0 {
		bracket = strings.TrimSuffix(strings.TrimPrefix(text[index+1:], "["), "]")
		text = text[:index]
	}
	if left, right, ok := strings.Cut(text, "..."); ok {
		text = left
		summary.Upstream = stringPtrOrNil(right)
	}
	branch := strings.TrimSpace(text)
	if branch != "" && !strings.Contains(branch, "no branch") {
		summary.Branch = &branch
	}

	for _, part := range strings.Split(bracket, ",") {
		part = strings.TrimSpace(part)
		if value, ok := strings.CutPrefix(part, "ahead "); ok {
			summary.Ahead = parseNonNegativeInt(value)
		}
		if value, ok := strings.CutPrefix(part, "behind "); ok {
			summary.Behind = parseNonNegativeInt(value)
		}
	}
}

func parseStatusEntry(line string) (contracts.GitStatusEntry, bool) {
	if len(line) < 3 {
		return contracts.GitStatusEntry{}, false
	}
	status := line[:2]
	rawPath := line[3:]
	path, originalPath := parsePorcelainPath(status, rawPath)
	if path == "" {
		return contracts.GitStatusEntry{}, false
	}

	return contracts.GitStatusEntry{
		Path:           path,
		OriginalPath:   originalPath,
		Status:         status,
		IndexStatus:    status[:1],
		WorkTreeStatus: status[1:2],
		Kind:           StatusKind(status),
	}, true
}

func StatusKind(status string) contracts.GitFileStatusKind {
	if status == "??" {
		return contracts.GitFileStatusKindUntracked
	}
	if status == "!!" {
		return contracts.GitFileStatusKindIgnored
	}
	if isConflictStatus(status) {
		return contracts.GitFileStatusKindConflicted
	}
	if strings.Contains(status, "R") {
		return contracts.GitFileStatusKindRenamed
	}
	if strings.Contains(status, "C") {
		return contracts.GitFileStatusKindCopied
	}
	if strings.Contains(status, "A") {
		return contracts.GitFileStatusKindAdded
	}
	if strings.Contains(status, "D") {
		return contracts.GitFileStatusKindDeleted
	}
	if strings.ContainsAny(status, "MT") {
		return contracts.GitFileStatusKindModified
	}
	return contracts.GitFileStatusKindClean
}

func parsePorcelainPath(status string, rawPath string) (string, *string) {
	if strings.ContainsAny(status, "RC") {
		if left, right, ok := strings.Cut(rawPath, " -> "); ok {
			original := normalizePorcelainPath(left)
			path := normalizePorcelainPath(right)
			if original != "" {
				return path, &original
			}
			return path, nil
		}
	}
	return normalizePorcelainPath(rawPath), nil
}

func normalizePorcelainPath(rawPath string) string {
	path := strings.TrimSpace(rawPath)
	if path == "" {
		return ""
	}
	if strings.HasPrefix(path, "\"") && strings.HasSuffix(path, "\"") {
		if unquoted, err := strconv.Unquote(path); err == nil {
			path = unquoted
		} else {
			path = strings.Trim(path, "\"")
		}
	}
	return strings.ReplaceAll(path, "\\", "/")
}

func isConflictStatus(status string) bool {
	switch status {
	case "DD", "AU", "UD", "UA", "DU", "AA", "UU":
		return true
	default:
		return strings.Contains(status, "U")
	}
}

func parseNonNegativeInt(value string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func stringPtrOrNil(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
