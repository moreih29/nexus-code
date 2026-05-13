package git

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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

func writeFakeGit(t *testing.T, dir string, script string) {
	t.Helper()
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
