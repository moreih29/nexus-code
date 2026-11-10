package git

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
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
	root := fixtureDir("blob")
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
