package git

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

	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	defaultStdoutCapBytes = 10 * 1024 * 1024
)

type RunParams struct {
	Args           []string          `json:"args"`
	Cwd            string            `json:"cwd,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	Interactive    bool              `json:"interactive,omitempty"`
	StdoutCapBytes int64             `json:"stdoutCapBytes,omitempty"`
}

type RunResult struct {
	Stdout       string      `json:"stdout"`
	Stderr       string      `json:"stderr"`
	Code         int         `json:"code"`
	ErrorKind    Kind        `json:"errorKind,omitempty"`
	ErrorHint    *ActionHint `json:"errorHint,omitempty"`
	ErrorMessage string      `json:"errorMessage,omitempty"`
}

// Run executes one git command and returns stdout/stderr plus Git's exit code.
// Non-zero Git exits are classified data, not transport failures.
func (s *Service) Run(ctx context.Context, raw json.RawMessage) (any, error) {
	params, err := parseRunParams(raw)
	if err != nil {
		return nil, err
	}
	cmd, err := s.command(ctx, params.Args, params.Cwd, params.Env, params.Interactive)
	if err != nil {
		return nil, err
	}

	stdoutCap := params.StdoutCapBytes
	if stdoutCap <= 0 {
		stdoutCap = defaultStdoutCapBytes
	}
	var stdout cappedBuffer
	stdout.cap = stdoutCap
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()
	if stdout.overflow {
		return RunResult{
			Stdout:       "",
			Stderr:       stderr.String(),
			Code:         0,
			ErrorKind:    KindOutputTooLarge,
			ErrorHint:    HintForKind(KindOutputTooLarge),
			ErrorMessage: MessageForKind(KindOutputTooLarge, MessageContext{Args: params.Args, LimitBytes: stdoutCap}),
		}, nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(err)
	if fatal != nil {
		return nil, fatal
	}
	return buildRunResult(stdout.String(), stderr.String(), code, params.Args), nil
}

// buildRunResult attaches classification fields when Git exits unsuccessfully.
func buildRunResult(stdout string, stderr string, code int, args []string) RunResult {
	result := RunResult{Stdout: stdout, Stderr: stderr, Code: code}
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
	}
	cmd := exec.CommandContext(ctx, "git", args...)
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
	cmd := exec.CommandContext(ctx, "git", "rev-parse", "--show-toplevel")
	cmd.Dir = root
	cmd.Env = gitEnv(nil, false, commandAskpass{})
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return filepath.Clean(strings.TrimSpace(string(out))), nil
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
}

func (s *Service) commandAskpass() (commandAskpass, error) {
	socketPath, err := s.ensureAskpassServer()
	if err != nil {
		return commandAskpass{}, err
	}
	helperPath, err := os.Executable()
	if err != nil {
		return commandAskpass{}, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git askpass helper unavailable"}
	}
	return commandAskpass{helperPath: helperPath, socketPath: socketPath}, nil
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
	return env
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

func gitExitCode(err error) (int, error) {
	if err == nil {
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	return 0, mapGitStartError(err, nil)
}

func mapGitStartError(err error, args []string) error {
	if errors.Is(err, exec.ErrNotFound) {
		return proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git executable not found"}
	}
	return proto.CodedError{Code: proto.CodeRequestFailed, Msg: err.Error()}
}

type cappedBuffer struct {
	buf      bytes.Buffer
	cap      int64
	overflow bool
}

// String returns the captured stdout prefix.
func (b *cappedBuffer) String() string {
	return b.buf.String()
}

// Write records stdout until the configured cap and detects overflow.
func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.cap <= 0 {
		return b.buf.Write(p)
	}
	remaining := b.cap - int64(b.buf.Len())
	if remaining <= 0 {
		b.overflow = true
		return len(p), nil
	}
	if int64(len(p)) > remaining {
		b.overflow = true
		_, _ = b.buf.Write(p[:remaining])
		return len(p), nil
	}
	return b.buf.Write(p)
}
