package git

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"

	"github.com/nexus-code/nexus-code/internal/redact"
)

const (
	defaultStdoutCapBytes = 16 << 20
	maxStdoutCapBytes     = 64 << 20
	captureTailBytes      = 1 << 20
	outputTruncated       = "[Git output truncated to the last 1 MiB]\n"
)

var errGitOutputLimit = errors.New("git stdout budget exceeded")

func stdoutBudget(requested int64) int64 {
	if requested <= 0 {
		return defaultStdoutCapBytes
	}
	return min(requested, maxStdoutCapBytes)
}

type tailBuffer struct {
	data     []byte
	start    int
	overflow bool
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if n >= captureTailBytes {
		b.overflow = b.overflow || len(b.data)+n > captureTailBytes
		b.data = append(b.data[:0], p[n-captureTailBytes:]...)
		b.start = 0
		return n, nil
	}
	fill := min(n, captureTailBytes-len(b.data))
	b.data = append(b.data, p[:fill]...)
	if fill < n {
		b.overflow = true
		p = p[fill:]
		written := copy(b.data[b.start:], p)
		b.start = (b.start + written) % captureTailBytes
		b.start += copy(b.data[b.start:], p[written:])
	}
	return n, nil
}

func (b *tailBuffer) String() string {
	return string(b.data[b.start:]) + string(b.data[:b.start])
}

type gitStderr struct{ tailBuffer }

func (b *gitStderr) String() string {
	s := b.tailBuffer.String()
	if b.overflow {
		_, s, _ = strings.Cut(s, "\n")
		return outputTruncated + redact.Credentials(s)
	}
	return redact.Credentials(s)
}

func startGitOutput(ctx context.Context, cmd *exec.Cmd) (stdout io.Reader, finish func() error, err error) {
	reader, writer := io.Pipe()
	cmd.Stdout = writer
	if err := cmd.Start(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return nil, nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = reader.CloseWithError(ctx.Err()) })
	waited := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		_ = writer.Close()
		waited <- err
	}()
	return reader, func() error {
		stop()
		_ = reader.Close()
		return <-waited
	}, nil
}

func runCapturedCommand(ctx context.Context, cmd *exec.Cmd) (string, string, int, error) {
	stdout := cappedBuffer{cap: defaultStdoutCapBytes}
	var stderr gitStderr
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	if err := ctx.Err(); err != nil {
		return "", "", 0, err
	}
	if stdout.overflow {
		return "", "", 0, outputLimitFailure(defaultStdoutCapBytes)
	}
	code, err := gitExitCode(cmd.ProcessState, runErr)
	return stdout.String(), stderr.String(), code, err
}

func outputLimitFailure(limit int64) error {
	return classifiedFailure(KindOutputTooLarge, MessageForKind(KindOutputTooLarge, MessageContext{LimitBytes: limit}))
}
