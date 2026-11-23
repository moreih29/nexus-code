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
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	waitDelayFixtureAddr = "NEXUS_TEST_GIT_WAIT_ADDR"
	waitDelayFixtureExe  = "NEXUS_TEST_GIT_WAIT_EXE"
	waitDelayStdout      = "git's stdout\n"
	waitDelayStderr      = "git's stderr\n"
	fixtureWaitDelay     = 50 * time.Millisecond
)

func runWaitDelayFixture(addr string) int {
	if len(os.Args) < 2 {
		return 1
	}
	if os.Args[1] == "--hold-pipes" || os.Args[1] == "--overflow-child" {
		conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
		if err != nil {
			return 1
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		if os.Args[1] == "--overflow-child" {
			if _, err := io.ReadFull(conn, make([]byte, 1)); err != nil {
				return 1
			}
			_, _ = io.WriteString(os.Stdout, strings.Repeat("x", 2048))
		}
		_, _ = io.Copy(conn, conn)
		return 0
	}
	if os.Args[1] == "log" {
		_, _ = os.Stdout.Write(syntheticLogStdout(1))
	} else {
		_, _ = io.WriteString(os.Stdout, waitDelayStdout)
	}
	_, _ = io.WriteString(os.Stderr, waitDelayStderr)
	helperArg := "--hold-pipes"
	if os.Args[1] == "overflow" {
		helperArg = "--overflow-child"
	}
	helper := exec.Command(os.Getenv(waitDelayFixtureExe), helperArg)
	helper.Stdout = os.Stdout
	helper.Stderr = os.Stderr
	if err := helper.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if os.Args[1] == "wait-for-helper" || os.Args[1] == "overflow" {
		if err := helper.Wait(); err != nil {
			return 1
		}
	} else {
		_ = helper.Process.Release()
	}
	return 0
}

func setupInheritedPipeFixture(t *testing.T) {
	t.Helper()
	setFakeGitExecutable(t, "wait-delay")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(waitDelayFixtureExe, exe)
}

func listenForPipeHolder(t *testing.T) *net.TCPListener {
	t.Helper()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	t.Setenv(waitDelayFixtureAddr, listener.Addr().String())
	if err := listener.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	return listener
}

func TestGitSuccessWithInheritedOutputPipes(t *testing.T) {
	setupInheritedPipeFixture(t)
	wantRun := RunResult{Stdout: waitDelayStdout, Stderr: waitDelayStderr, Code: 0}
	logCall := func(s *Service, ctx context.Context) (any, error) {
		return s.Log(ctx, json.RawMessage(`{"source":false}`))
	}
	for _, tc := range []struct {
		name     string
		call     func(*Service, context.Context) (any, error)
		want     any
		logBatch bool
	}{
		{"run", func(s *Service, ctx context.Context) (any, error) {
			return s.Run(ctx, json.RawMessage(`{"args":["status"]}`))
		}, wantRun, false},
		{"capture", func(s *Service, ctx context.Context) (any, error) {
			out, stderr, code, err := s.capture(ctx, "", []string{"status"}, false)
			return RunResult{Stdout: out, Stderr: stderr, Code: code}, err
		}, wantRun, false},
		{"stream", func(s *Service, ctx context.Context) (any, error) {
			return s.Stream(ctx, json.RawMessage(`{"streamId":"status","args":["status"]}`))
		}, RunResult{Stderr: waitDelayStderr, Code: 0}, false},
		{"log", logCall, LogResult{Count: 1}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			listener := listenForPipeHolder(t)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			svc := New(t.TempDir())
			svc.commandWaitDelay = fixtureWaitDelay
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
				if err := conn.SetDeadline(time.Now().Add(time.Second)); err != nil {
					t.Fatal(err)
				}
				if _, err := conn.Write([]byte{1}); err != nil {
					t.Fatal("Git's successful reply terminated its helper:", err)
				}
				if _, err := io.ReadFull(conn, make([]byte, 1)); err != nil {
					t.Fatal("Git's successful reply terminated its helper:", err)
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

func TestCancelledGitReturnsWithInheritedOutputPipes(t *testing.T) {
	setupInheritedPipeFixture(t)
	listener := listenForPipeHolder(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc := New(t.TempDir())
	svc.commandWaitDelay = fixtureWaitDelay
	cmd, err := svc.command(ctx, []string{"wait-for-helper"}, "", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdout = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait() }()
	conn, err := listener.AcceptTCP()
	if err != nil {
		t.Fatal("helper never connected:", err)
	}
	defer conn.Close()

	cancel()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("cancelled Git unexpectedly succeeded")
		}
	case <-time.After(3 * time.Second):
		_ = conn.Close()
		<-finished
		t.Fatal("Git wait is still blocked on the helper's output pipe")
	}
}

func runOutputBudgetFixture() int {
	if len(os.Args) < 3 {
		return 1
	}
	size, err := strconv.Atoi(os.Args[2])
	if err != nil {
		return 1
	}
	chunk := strings.Repeat("a", 32<<10)
	for size > 0 {
		n := min(len(chunk), size)
		if _, err := io.WriteString(os.Stdout, chunk[:n]); err != nil {
			return 1
		}
		size -= n
	}
	if len(os.Args) > 3 && os.Args[3] == "stderr-tail" {
		_, _ = io.WriteString(os.Stderr, "first diagnostic\n"+strings.Repeat("discard me\n", 100_000)+"last diagnostic\n")
	}
	return 0
}

func TestGitOutputBudgets(t *testing.T) {
	setFakeGitExecutable(t, "output-budget")
	svc := New(t.TempDir())
	for _, tc := range []struct {
		name       string
		bytes      int
		budget     int
		want       Kind
		stderrTail bool
	}{
		{"default", 12 << 20, 0, "", true},
		{"default overflow", (16 << 20) + 1, 0, KindOutputTooLarge, false},
		{"requested", 17 << 20, 20 << 20, "", false},
		{"hard limit", (64 << 20) + 1, 65 << 20, KindOutputTooLarge, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := []string{"bulk", strconv.Itoa(tc.bytes)}
			if tc.stderrTail {
				args = append(args, "stderr-tail")
			}
			raw, err := json.Marshal(RunParams{Args: args, StdoutCapBytes: int64(tc.budget)})
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
			if tc.want == "" && len(got.Stdout) != tc.bytes {
				t.Fatalf("Git retained %d stdout bytes, want %d", len(got.Stdout), tc.bytes)
			}
			if tc.stderrTail && (strings.Contains(got.Stderr, "first diagnostic") || !strings.HasSuffix(got.Stderr, "last diagnostic\n")) {
				t.Fatalf("Git retained %d stderr bytes with expected tail: %t", len(got.Stderr), strings.HasSuffix(got.Stderr, "last diagnostic\n"))
			}
		})
	}
	stdout, _, _, err := svc.capture(context.Background(), "", []string{"bulk", strconv.Itoa((16 << 20) + 1)}, false)
	var failure Failure
	if !errors.As(err, &failure) || failure.Kind != KindOutputTooLarge || stdout != "" {
		t.Fatalf("capture returned %d bytes, error %v", len(stdout), err)
	}
}
