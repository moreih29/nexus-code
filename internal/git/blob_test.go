package git

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

type blobFixture struct {
	Method string             `json:"method"`
	Case   string             `json:"case"`
	Params BlobParams         `json:"params"`
	Events []blobFixtureEvent `json:"events"`
	Result *BlobResult        `json:"result,omitempty"`
	Error  *blobFixtureError  `json:"error,omitempty"`
}

type blobFixtureEvent struct {
	Name    string           `json:"name"`
	Payload BlobChunkPayload `json:"payload"`
}

type blobFixtureError struct {
	Kind    Kind   `json:"kind"`
	Message string `json:"message"`
}

func TestParseBlobCatFileOutputFixtures(t *testing.T) {
	root := blobFixtureRoot(t)
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read blob fixtures: %v", err)
	}
	loaded := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(root, name)
			stdout, err := os.ReadFile(filepath.Join(dir, "stdout.bin"))
			if err != nil {
				t.Fatalf("read stdout.bin: %v", err)
			}
			expectedBytes, err := os.ReadFile(filepath.Join(dir, "expected.json"))
			if err != nil {
				t.Fatalf("read expected.json: %v", err)
			}
			var expected blobFixture
			if err := json.Unmarshal(expectedBytes, &expected); err != nil {
				t.Fatalf("parse expected.json: %v", err)
			}
			params := expected.Params
			if params.MaxBytes <= 0 {
				params.MaxBytes = defaultBlobMaxBytes
			}
			if params.MaxChunkBytes <= 0 {
				params.MaxChunkBytes = streamChunkBytes
			}

			var events []blobFixtureEvent
			result, err := parseBlobCatFileOutput(context.Background(), params, bytes.NewReader(stdout), func(payload BlobChunkPayload) error {
				events = append(events, blobFixtureEvent{Name: "git.blob.chunk", Payload: payload})
				return nil
			})
			if err != nil {
				t.Fatalf("parseBlobCatFileOutput: %v", err)
			}
			if expected.Error != nil {
				if result.ErrorKind != expected.Error.Kind || result.ErrorMessage != expected.Error.Message {
					t.Fatalf("error got kind=%q message=%q want kind=%q message=%q", result.ErrorKind, result.ErrorMessage, expected.Error.Kind, expected.Error.Message)
				}
				if len(events) != 0 {
					t.Fatalf("missing emitted events: %#v", events)
				}
				return
			}
			if result.ErrorKind != "" || result.ErrorMessage != "" {
				t.Fatalf("unexpected error result: %#v", result)
			}
			if !reflect.DeepEqual(events, expected.Events) {
				t.Fatalf("events got %s want %s", canonicalJSON(t, events), canonicalJSON(t, expected.Events))
			}
			if expected.Result == nil {
				t.Fatal("fixture has no result")
			}
			if !reflect.DeepEqual(result, *expected.Result) {
				t.Fatalf("result got %s want %s", canonicalJSON(t, result), canonicalJSON(t, *expected.Result))
			}
		})
		loaded++
	}
	if loaded == 0 {
		t.Fatal("no blob fixtures loaded")
	}
}

func TestBlobRegisteredWithDispatcher(t *testing.T) {
	root := t.TempDir()
	runGitCommand(t, root, "init", "-b", "main")
	runGitCommand(t, root, "config", "user.email", "nexus@example.test")
	runGitCommand(t, root, "config", "user.name", "Nexus Test")
	writeFile(t, filepath.Join(root, "README.md"), "hello from HEAD\n")
	runGitCommand(t, root, "add", "README.md")
	runGitCommand(t, root, "commit", "-m", "initial")

	d := dispatch.New()
	service := New(root)
	Register(d, service)
	var events []BlobChunkPayload
	service.SetEventSink(func(event string, payload any) error {
		if event == "git.blob.chunk" {
			events = append(events, payload.(BlobChunkPayload))
		}
		return nil
	})
	res := d.Dispatch(context.Background(), proto.Request{ID: "git.blob", Method: "git.blob", Params: json.RawMessage(`{"ref":"HEAD","relPath":"README.md","maxChunkBytes":65536}`)})
	if res.Error != nil {
		t.Fatalf("git.blob dispatch returned error: %#v", res.Error)
	}
	result, ok := res.Result.(BlobResult)
	if !ok {
		t.Fatalf("git.blob result type = %T", res.Result)
	}
	if result.Size != 16 || result.IsBinary || result.Encoding != "utf8" || result.Truncated {
		t.Fatalf("unexpected result: %#v", result)
	}
	if len(events) != 1 || events[0].HeaderProbe == nil {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestBlobRejectsWorkingRef(t *testing.T) {
	_, err := parseBlobParams(json.RawMessage(`{"ref":"WORKING","relPath":"README.md"}`))
	if err == nil {
		t.Fatal("expected WORKING ref error")
	}
}

func blobFixtureRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "tests", "fixtures", "git", "blob"))
}
