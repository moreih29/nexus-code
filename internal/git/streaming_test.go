package git

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestStreamDefaultEmitsStdoutAndClassifiesStderr(t *testing.T) {
	root := t.TempDir()
	fakeDir := t.TempDir()
	writeFakeGit(t, fakeDir, `#!/bin/sh
printf 'stdout chunk\n'
printf 'fatal: Authentication failed for '\''https://example.invalid/repo.git'\''\n' >&2
exit 128
`)
	t.Setenv("PATH", fakeDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	service := New(root)
	var events []StreamChunkPayload
	service.SetEventSink(func(event string, payload any) error {
		if event == "git.streamChunk" {
			events = append(events, payload.(StreamChunkPayload))
		}
		return nil
	})

	result, err := service.Stream(context.Background(), json.RawMessage(`{"streamId":"stdout-default","args":["clone"]}`))
	if err != nil {
		t.Fatalf("Stream returned transport error: %v", err)
	}
	runResult := result.(RunResult)
	if runResult.Code != 128 || runResult.ErrorKind != KindAuth {
		t.Fatalf("result code/kind = %d/%q, want 128/%q", runResult.Code, runResult.ErrorKind, KindAuth)
	}
	if got := joinStreamChunks(t, events); got != "stdout chunk\n" {
		t.Fatalf("streamed chunks = %q, want stdout only", got)
	}
	if !strings.Contains(runResult.Stderr, "Authentication failed") {
		t.Fatalf("stderr was not retained for classification: %q", runResult.Stderr)
	}
}

func TestStreamStderrEmitsStderrAndClassifiesFinalResult(t *testing.T) {
	root := t.TempDir()
	fakeDir := t.TempDir()
	writeFakeGit(t, fakeDir, `#!/bin/sh
printf 'stdout should not stream\n'
printf 'Receiving objects: 100%% (1/1)\n' >&2
printf 'fatal: Authentication failed for '\''https://example.invalid/repo.git'\''\n' >&2
exit 128
`)
	t.Setenv("PATH", fakeDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	service := New(root)
	var events []StreamChunkPayload
	service.SetEventSink(func(event string, payload any) error {
		if event == "git.streamChunk" {
			events = append(events, payload.(StreamChunkPayload))
		}
		return nil
	})

	result, err := service.Stream(context.Background(), json.RawMessage(`{"streamId":"stderr-mode","args":["clone","--progress"],"streamStderr":true}`))
	if err != nil {
		t.Fatalf("Stream returned transport error: %v", err)
	}
	runResult := result.(RunResult)
	streamed := joinStreamChunks(t, events)
	if strings.Contains(streamed, "stdout should not stream") {
		t.Fatalf("streamStderr leaked stdout chunks: %q", streamed)
	}
	if !strings.Contains(streamed, "Receiving objects: 100%") || !strings.Contains(streamed, "Authentication failed") {
		t.Fatalf("streamed stderr chunks = %q", streamed)
	}
	if runResult.Code != 128 || runResult.ErrorKind != KindAuth {
		t.Fatalf("result code/kind = %d/%q, want 128/%q", runResult.Code, runResult.ErrorKind, KindAuth)
	}
	if !strings.Contains(runResult.Stderr, "Authentication failed") {
		t.Fatalf("stderr was not retained for classification: %q", runResult.Stderr)
	}
}

// TestStreamingHandlersStopGitWhenReadingStops covers handlers that stopped
// reading git's output early (an event emit failed because the dialer was
// gone, or the progress scanner gave up) and then called cmd.Wait() with git
// still running: git blocked on the full pipe, so the handler, the git
// process and the stream id leaked forever.
func TestStreamingHandlersStopGitWhenReadingStops(t *testing.T) {
	fakeDir := t.TempDir()
	// Endless output; the only way for this "git" to exit is to be killed.
	writeFakeGit(t, fakeDir, `#!/bin/sh
case "$1" in
clone) exec tr '\000' x < /dev/zero >&2 ;;
log) exec yes "$(printf 'abc\037a\037\037n\037e\0372020-01-01T00:00:00Z\037s\037b\037\036')" ;;
*) exec yes 'diff --git a/x b/x' ;;
esac
`)
	t.Setenv("PATH", fakeDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	parent := t.TempDir()

	cases := []struct {
		name string
		call func(*Service) (any, error)
	}{
		{"stream", func(s *Service) (any, error) {
			return s.Stream(context.Background(), json.RawMessage(`{"streamId":"s","args":["cat-file","-p","HEAD:x"]}`))
		}},
		{"diff", func(s *Service) (any, error) {
			return s.Diff(context.Background(), json.RawMessage(`{"streamId":"s"}`))
		}},
		{"stashShow", func(s *Service) (any, error) {
			return s.StashShow(context.Background(), json.RawMessage(`{"streamId":"s","index":0}`))
		}},
		{"log", func(s *Service) (any, error) {
			return s.Log(context.Background(), json.RawMessage(`{"streamId":"s"}`))
		}},
		{"clone", func(s *Service) (any, error) {
			raw, _ := json.Marshal(CloneParams{StreamID: "s", URL: "https://example.invalid/repo.git", ParentDir: parent, Name: "repo"})
			return s.Clone(context.Background(), raw)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			service := New(t.TempDir())
			service.SetEventSink(func(string, any) error { return errors.New("dialer gone") })
			done := make(chan error, 1)
			go func() {
				_, err := tc.call(service)
				done <- err
			}()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("expected the handler to fail")
				}
			case <-time.After(processTimeout):
				service.mu.Lock()
				cancel := service.streams["s"]
				service.mu.Unlock()
				if cancel != nil {
					cancel()
				}
				<-done
				t.Fatal("handler still blocked in cmd.Wait() after it stopped reading git output")
			}
			service.mu.Lock()
			defer service.mu.Unlock()
			if len(service.streams) != 0 {
				t.Fatalf("stream ids still registered: %v", service.streams)
			}
		})
	}
}

func writeFakeGit(t *testing.T, dir string, script string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake git is a shell script, which Windows cannot run")
	}
	path := filepath.Join(dir, "git")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake git: %v", err)
	}
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatalf("chmod fake git: %v", err)
	}
}

func joinStreamChunks(t *testing.T, events []StreamChunkPayload) string {
	t.Helper()
	var out strings.Builder
	for _, event := range events {
		decoded, err := base64.StdEncoding.DecodeString(event.Chunk)
		if err != nil {
			t.Fatalf("decode stream chunk: %v", err)
		}
		out.Write(decoded)
	}
	return out.String()
}
