package git

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/nexus-code/nexus-code/internal/msix"
	"github.com/nexus-code/nexus-code/internal/proto"
	"github.com/nexus-code/nexus-code/internal/redact"
)

type RunParams struct {
	Args           []string          `json:"args"`
	Cwd            string            `json:"cwd,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	Interactive    bool              `json:"interactive,omitempty"`
	StdoutCapBytes int64             `json:"stdoutCapBytes,omitempty"`
	RunID          string            `json:"runId,omitempty"`
}

type RunResult struct {
	Stdout       string      `json:"stdout"`
	Stderr       string      `json:"stderr"`
	Code         int         `json:"code"`
	ErrorKind    Kind        `json:"errorKind,omitempty"`
	ErrorHint    *ActionHint `json:"errorHint,omitempty"`
	ErrorMessage string      `json:"errorMessage,omitempty"`
}

func (s *Service) Run(ctx context.Context, raw json.RawMessage) (any, error) {
	params, err := parseRunParams(raw)
	if err != nil {
		return nil, err
	}
	ctx, done, err := s.startRun(ctx, params.RunID)
	if err != nil {
		return nil, err
	}
	defer done()
	cmdCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd, err := s.command(cmdCtx, params.Args, params.Cwd, params.Env, params.Interactive)
	if err != nil {
		return nil, err
	}

	stdoutCap := stdoutBudget(params.StdoutCapBytes)
	stdout := cappedBuffer{cap: stdoutCap, cancel: cancel}
	var stderr gitStderr
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err, cleanupErr := runGitWithOutputLimit(cmd, &stdout)
	if cleanupErr != nil {
		return nil, mapGitStartError(cleanupErr, nil)
	}
	if stdout.overflow {
		return outputLimitResult(stderr.String(), stdoutCap), nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(cmd.ProcessState, err)
	if fatal != nil {
		return nil, fatal
	}
	return buildRunResult(stdout.String(), stderr.String(), code, params.Args), nil
}

func outputLimitResult(stderr string, limit int64) RunResult {
	return RunResult{
		Stderr:       stderr,
		ErrorKind:    KindOutputTooLarge,
		ErrorHint:    HintForKind(KindOutputTooLarge),
		ErrorMessage: MessageForKind(KindOutputTooLarge, MessageContext{LimitBytes: limit}),
	}
}

func buildRunResult(stdout string, stderr string, code int, args []string) RunResult {
	result := RunResult{Stdout: stdout, Stderr: redact.Credentials(stderr), Code: code}
	if code == 0 {
		return result
	}
	kind := Classify(stderr)
	result.ErrorKind = kind
	result.ErrorHint = HintForKind(kind)
	result.ErrorMessage = MessageForKind(kind, MessageContext{
		Stderr:   stderr,
		Args:     args,
		ExitCode: &code,
	})
	return result
}

func (s *Service) capture(ctx context.Context, cwd string, args []string, interactive bool) (stdout, stderr string, code int, err error) {
	return s.captureEnv(ctx, cwd, args, nil, interactive)
}

func (s *Service) captureEnv(ctx context.Context, cwd string, args []string, env map[string]string, interactive bool) (stdout, stderr string, code int, err error) {
	cmd, err := s.command(ctx, args, cwd, env, interactive)
	if err != nil {
		return "", "", 0, err
	}
	return runCapturedCommand(ctx, cmd)
}

func gitError(args []string, stderr string, code int) error {
	kind := Classify(stderr)
	message := MessageForKind(kind, MessageContext{Stderr: stderr, Args: args, ExitCode: &code})
	if strings.TrimSpace(message) == "" {
		message = strings.TrimSpace(stderr)
	}
	if message == "" {
		message = fmt.Sprintf("%s exited with code %d", renderGitCommand(args), code)
	}
	return classifiedFailure(kind, message)
}

func parseRunParams(raw json.RawMessage) (RunParams, error) {
	var params RunParams
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return params, proto.ProtocolError("git.run params must include args")
	}
	if err := validateGitArgs(params.Args); err != nil {
		return params, err
	}
	return params, nil
}

func validateGitArgs(args []string) error {
	if len(args) == 0 {
		return proto.ProtocolError("git args are required")
	}
	for _, arg := range args {
		if strings.Contains(arg, "\x00") {
			return proto.ProtocolError("git args must not contain NUL")
		}
	}
	return nil
}

var literalPathspecs = map[string]string{"GIT_LITERAL_PATHSPECS": "1"}

func selectedPathEnv(paths []string) map[string]string {
	if len(paths) == 0 {
		return nil
	}
	return literalPathspecs
}

func (s *Service) command(ctx context.Context, args []string, cwd string, env map[string]string, interactive bool) (*exec.Cmd, error) {
	if err := validateGitArgs(args); err != nil {
		return nil, err
	}
	resolvedCwd, err := s.resolveCwd(ctx, cwd)
	if err != nil {
		return nil, err
	}
	var askpass commandAskpass
	if interactive {
		askpass, err = s.commandAskpass()
		if err != nil {
			return nil, err
		}
		askpass.runID = runIDFrom(ctx)
	}
	cmd := exec.CommandContext(ctx, gitBinary(), args...)
	cmd.WaitDelay = s.commandWaitDelay
	cmd.Dir = resolvedCwd
	cmd.Env = gitEnv(env, interactive, askpass)
	return cmd, nil
}

func (s *Service) resolveCwd(ctx context.Context, cwd string) (string, error) {
	if strings.Contains(cwd, "\x00") {
		return "", proto.ProtocolError("git cwd must not contain NUL")
	}
	if strings.TrimSpace(cwd) == "" {
		return s.root, nil
	}

	var clean string
	if filepath.IsAbs(cwd) {
		clean = filepath.Clean(cwd)
	} else {
		clean = filepath.Clean(filepath.Join(s.root, cwd))
	}
	if isInside(clean, s.root) {
		return clean, nil
	}

	topLevel, err := gitTopLevel(ctx, s.root)
	if err == nil && samePath(clean, topLevel) {
		return clean, nil
	}
	return "", proto.ProtocolError("git cwd must stay inside the workspace or its detected repository root")
}

func gitTopLevel(ctx context.Context, root string) (string, error) {
	cmd := exec.CommandContext(ctx, gitBinary(), "rev-parse", "--show-toplevel", "--show-cdup")
	cmd.Dir = root
	cmd.Env = gitEnv(nil, false, commandAskpass{})
	cmd.WaitDelay = time.Second
	out, stderr, code, err := runCapturedCommand(ctx, cmd)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", gitError(cmd.Args[1:], stderr, code)
	}
	lines := parseRevParseLines(out)
	cdup := ""
	if len(lines) > 1 {
		cdup = lines[1]
	}
	return logicalTopLevel(root, cdup, filepath.Clean(strings.TrimSpace(lines[0]))), nil
}

func isInside(candidate string, root string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func samePath(a string, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b)
}

type commandAskpass struct {
	helperPath string
	socketPath string
	runID      string
}

func (s *Service) commandAskpass() (commandAskpass, error) {
	socketPath, err := s.ensureAskpassServer()
	if err != nil {
		return commandAskpass{}, err
	}
	helperPath, err := askpassHelperPath()
	if err != nil {
		return commandAskpass{}, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git askpass helper unavailable"}
	}
	return commandAskpass{helperPath: helperPath, socketPath: socketPath}, nil
}

func askpassHelperPath() (string, error) {
	if alias, ok := msix.AgentAlias(); ok {
		return alias, nil
	}
	return os.Executable()
}

func gitEnv(overrides map[string]string, interactive bool, askpass commandAskpass) []string {
	env := os.Environ()
	env = appendOrReplaceEnv(env, "GIT_TERMINAL_PROMPT", "0")
	env = appendOrReplaceEnv(env, "GIT_FLUSH", "1")
	for key, value := range overrides {
		if strings.Contains(key, "\x00") || strings.Contains(value, "\x00") || strings.Contains(key, "=") || key == "" {
			continue
		}
		env = appendOrReplaceEnv(env, key, value)
	}
	if interactive {
		env = appendOrReplaceEnv(env, askpassSocketEnv, askpass.socketPath)
		env = appendOrReplaceEnv(env, askpassModeEnv, "1")
		if askpass.runID != "" {
			env = appendOrReplaceEnv(env, askpassRunEnv, askpass.runID)
		}
		env = appendOrReplaceEnv(env, "GIT_ASKPASS", askpass.helperPath)
		env = appendOrReplaceEnv(env, "SSH_ASKPASS", askpass.helperPath)
		env = appendOrReplaceEnv(env, "SSH_ASKPASS_REQUIRE", "force")
		if runtime.GOOS != "windows" && envValue(env, "DISPLAY") == "" {
			env = appendOrReplaceEnv(env, "DISPLAY", ":0")
		}
	} else {
		env = appendOrReplaceEnv(env, "GIT_ASKPASS", "echo")
		env = appendOrReplaceEnv(env, "SSH_ASKPASS_REQUIRE", "force")
		env = appendOrReplaceEnv(env, "SSH_ASKPASS", "echo")
	}
	return withSafeGitConfig(env)
}

var safeGitConfig = [][2]string{
	{"core.fsmonitor", "false"},
}

func withSafeGitConfig(env []string) []string {
	count, err := strconv.Atoi(envValue(env, "GIT_CONFIG_COUNT"))
	if err != nil || count < 0 {
		count = 0
	}
	for _, kv := range safeGitConfig {
		env = appendOrReplaceEnv(env, fmt.Sprintf("GIT_CONFIG_KEY_%d", count), kv[0])
		env = appendOrReplaceEnv(env, fmt.Sprintf("GIT_CONFIG_VALUE_%d", count), kv[1])
		count++
	}
	return appendOrReplaceEnv(env, "GIT_CONFIG_COUNT", strconv.Itoa(count))
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix)
		}
	}
	return ""
}

func appendOrReplaceEnv(env []string, key string, value string) []string {
	prefix := key + "="
	for i, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

func gitExitCode(state *os.ProcessState, err error) (int, error) {
	if err == nil {
		return 0, nil
	}
	if errors.Is(err, exec.ErrWaitDelay) && state != nil {
		return state.ExitCode(), nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	return 0, mapGitStartError(err, nil)
}

func mapGitStartError(err error, args []string) error {
	if errors.Is(err, exec.ErrNotFound) {
		return classifiedFailure(KindGitMissing, "git executable not found")
	}
	return proto.CodedError{Code: proto.CodeRequestFailed, Msg: redact.Credentials(err.Error())}
}

type cappedBuffer struct {
	buf      bytes.Buffer
	cap      int64
	overflow bool
	cancel   context.CancelFunc
}

func (b *cappedBuffer) String() string {
	return b.buf.String()
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if remaining := b.cap - int64(b.buf.Len()); int64(len(p)) > remaining {
		b.overflow = true
		_, _ = b.buf.Write(p[:remaining])
		if b.cancel != nil {
			b.cancel()
		}
		return int(remaining), errGitOutputLimit
	}
	return b.buf.Write(p)
}
