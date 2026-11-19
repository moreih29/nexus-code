package git

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	waitDelayFixtureAddr = "NEXUS_TEST_GIT_WAIT_ADDR"
	waitDelayFixtureExe  = "NEXUS_TEST_GIT_WAIT_EXE"
	waitDelayFixturePipe = "NEXUS_TEST_GIT_WAIT_PIPE"
	waitDelayStdout      = "git's stdout\n"
	waitDelayStderr      = "git's stderr\n"
)

// runWaitDelayFixture either runs the fake Git or holds the inherited pipes
// until the test closes its loopback connection.
func runWaitDelayFixture(addr string) int {
	if len(os.Args) < 2 {
		return 1
	}
	if os.Args[1] == "bulk" {
		size, _ := strconv.Atoi(os.Args[2])
		chunk := strings.Repeat("a", 32<<10)
		for size > 0 {
			n := min(len(chunk), size)
			_, _ = io.WriteString(os.Stdout, chunk[:n])
			size -= n
		}
		_, _ = io.WriteString(os.Stderr, "first diagnostic\n"+strings.Repeat("discard me\n", 100_000)+"last diagnostic\n")
		return 0
	}
	if os.Args[1] == "--hold-pipes" {
		conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
		if err != nil {
			return 1
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		_, _ = io.Copy(io.Discard, conn)
		return 0
	}
	if os.Args[1] == "log" {
		_, _ = os.Stdout.Write(syntheticLogStdout(1))
	} else {
		_, _ = io.WriteString(os.Stdout, waitDelayStdout)
	}
	_, _ = io.WriteString(os.Stderr, waitDelayStderr)
	helper := exec.Command(os.Getenv(waitDelayFixtureExe), "--hold-pipes")
	if os.Getenv(waitDelayFixturePipe) != "stderr" {
		helper.Stdout = os.Stdout
	}
	helper.Stderr = os.Stderr
	if err := helper.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	_ = helper.Process.Release()
	return 0
}

// TestGitSuccessWithInheritedOutputPipes starts an executable fixture on
// both Windows and Unix. A helper holds the pipes open past Git's exit.
func TestGitSuccessWithInheritedOutputPipes(t *testing.T) {
	setFakeGitExecutable(t)
	wantRun := RunResult{Stdout: waitDelayStdout, Stderr: waitDelayStderr, Code: 0}
	logCall := func(s *Service, ctx context.Context) (any, error) {
		return s.Log(ctx, json.RawMessage(`{"source":false}`))
	}
	for _, tc := range []struct {
		name     string
		hold     string
		call     func(*Service, context.Context) (any, error)
		want     any
		logBatch bool
	}{
		{"run", "both", func(s *Service, ctx context.Context) (any, error) {
			return s.Run(ctx, json.RawMessage(`{"args":["status"]}`))
		}, wantRun, false},
		{"capture", "both", func(s *Service, ctx context.Context) (any, error) {
			out, stderr, code, err := s.capture(ctx, "", []string{"status"}, false)
			return RunResult{Stdout: out, Stderr: stderr, Code: code}, err
		}, wantRun, false},
		{"stream", "both", func(s *Service, ctx context.Context) (any, error) {
			return s.Stream(ctx, json.RawMessage(`{"streamId":"status","args":["status"]}`))
		}, RunResult{Stderr: waitDelayStderr, Code: 0}, false},
		{"log stderr", "stderr", logCall, LogResult{Count: 1}, true},
		{"log both", "both", logCall, LogResult{Count: 1}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			t.Setenv(waitDelayFixtureAddr, listener.Addr().String())
			t.Setenv(waitDelayFixturePipe, tc.hold)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			svc := New(t.TempDir())
			var entries []LogEntry
			var streamed strings.Builder
			svc.SetEventSink(func(_ string, payload any) error {
				switch data := payload.(type) {
				case LogBatchPayload:
					entries = append(entries, data.Entries...)
				case StreamChunkPayload:
					chunk, err := base64.StdEncoding.DecodeString(data.Chunk)
					if err != nil {
						return err
					}
					streamed.Write(chunk)
				}
				return nil
			})
			type response struct {
				value any
				err   error
			}
			finished := make(chan response, 1)
			go func() {
				value, err := tc.call(svc, ctx)
				finished <- response{value, err}
			}()
			_ = listener.SetDeadline(time.Now().Add(5 * time.Second))
			conn, err := listener.AcceptTCP()
			if err != nil {
				t.Fatal("helper never connected:", err)
			}
			defer conn.Close()
			select {
			case got := <-finished:
				if got.err != nil || !reflect.DeepEqual(got.value, tc.want) {
					t.Fatalf("result = %+v, %v; want %+v", got.value, got.err, tc.want)
				}
				if tc.name == "stream" && streamed.String() != waitDelayStdout {
					t.Fatalf("streamed stdout = %q, want %q", streamed.String(), waitDelayStdout)
				}
				if tc.logBatch && (len(entries) != 1 || entries[0].Subject != "Subject 1") {
					t.Fatalf("Git's log entry was not delivered: %+v", entries)
				}
			case <-time.After(3 * time.Second):
				_ = conn.Close()
				<-finished
				t.Fatal("Git's successful reply waited for the helper to close its pipes")
			}
		})
	}
}

// setFakeGitExecutable exposes the test binary as Git on all supported OSes.
func setFakeGitExecutable(t *testing.T) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	name := "git"
	if runtime.GOOS == "windows" {
		name += ".exe"
		t.Setenv("PATHEXT", ".EXE")
	}
	if err := os.WriteFile(filepath.Join(dir, name), bin, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv(waitDelayFixtureExe, exe)
}

// TestGitOutputBudgets exercises default, requested and hard limits through
// the public command path, and retains only the latest diagnostic stderr.
func TestGitOutputBudgets(t *testing.T) {
	setFakeGitExecutable(t)
	t.Setenv(waitDelayFixtureAddr, "bulk fixture")
	svc := New(t.TempDir())
	for _, tc := range []struct {
		name   string
		bytes  int
		budget int
		want   Kind
	}{
		{"default", 12 << 20, 0, ""},
		{"default overflow", (16 << 20) + 1, 0, KindOutputTooLarge},
		{"requested", 17 << 20, 20 << 20, ""},
		{"hard limit", (64 << 20) + 1, 65 << 20, KindOutputTooLarge},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(RunParams{Args: []string{"bulk", strconv.Itoa(tc.bytes)}, StdoutCapBytes: int64(tc.budget)})
			if err != nil {
				t.Fatal(err)
			}
			value, err := svc.Run(context.Background(), raw)
			if err != nil {
				t.Fatal(err)
			}
			got := value.(RunResult)
			if got.ErrorKind != tc.want {
				t.Fatalf("Git error kind = %q, want %q", got.ErrorKind, tc.want)
			}
			if tc.want == "" && (len(got.Stdout) != tc.bytes || strings.Contains(got.Stderr, "first diagnostic") || !strings.HasSuffix(got.Stderr, "last diagnostic\n")) {
				t.Fatalf("Git retained %d stdout bytes and %d stderr bytes with expected tail: %t", len(got.Stdout), len(got.Stderr), strings.HasSuffix(got.Stderr, "last diagnostic\n"))
			}
		})
	}
	stdout, _, _, err := svc.capture(context.Background(), "", []string{"bulk", strconv.Itoa((16 << 20) + 1)}, false)
	var failure Failure
	if !errors.As(err, &failure) || failure.Kind != KindOutputTooLarge || stdout != "" {
		t.Fatalf("capture returned %d bytes, error %v", len(stdout), err)
	}
}
