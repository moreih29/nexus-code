package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"time"
)

// Exec runs the program once and returns its output, as for
// `claude --version`.
func (s *Service) Exec(ctx context.Context, raw json.RawMessage) (any, error) {
	var p ExecParams
	if err := decodeParams(raw, &p, "chat.exec params must include program"); err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.Program) == "" {
		return nil, protocolError("chat.exec program is required")
	}
	timeout := execTimeout
	if p.TimeoutMs > 0 && time.Duration(p.TimeoutMs)*time.Millisecond < timeout {
		timeout = time.Duration(p.TimeoutMs) * time.Millisecond
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, p.Program, p.Args...)
	cmd.Dir = p.Cwd
	cmd.Env = mergeEnv(p.Env)
	// A process the program leaves running can hold the output open.
	cmd.WaitDelay = time.Second
	stdout := &cappedBuffer{limit: execOutputCap}
	stderr := &cappedBuffer{limit: execOutputCap}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	err := runChatCommand(cmd, p.Args)

	result := ExecResult{Code: 0, Stdout: stdout.String(), Stderr: stderr.String()}
	if runCtx.Err() != nil {
		result.TimedOut = true
		result.Code = -1
		return result, nil
	}
	var exitErr *exec.ExitError
	switch {
	case err == nil, errors.Is(err, exec.ErrWaitDelay):
	case errors.As(err, &exitErr):
		result.Code = exitErr.ExitCode()
	default:
		result.Code = -1
		if result.Stderr == "" {
			result.Stderr = err.Error()
		}
	}
	return result, nil
}

// runChatCommand owns normal one-shot helpers. The app's Claude background
// command places --bg first and owns its own lifetime after launch.
func runChatCommand(cmd *exec.Cmd, args []string) error {
	if len(args) != 0 && (args[0] == "--bg" || args[0] == "--background") {
		return cmd.Run()
	}
	p := &process{cmd: cmd}
	cmd.Cancel = p.signalKill
	if err := p.startOwned(); err != nil {
		return err
	}
	defer p.releaseTree()
	return cmd.Wait()
}

// cappedBuffer keeps the first limit bytes written to it.
type cappedBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := b.limit - b.buf.Len(); room > 0 {
		if len(p) > room {
			b.buf.Write(p[:room])
		} else {
			b.buf.Write(p)
		}
	}
	return len(p), nil
}

func (b *cappedBuffer) String() string {
	return decodeOutput(b.buf.Bytes())
}
