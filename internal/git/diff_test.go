package git

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/proto"
)

type diffFixture struct {
	Params DiffParams         `json:"params"`
	Events []diffFixtureEvent `json:"events"`
	Result DiffResult         `json:"result"`
}

type diffFixtureEvent struct {
	Name    string           `json:"name"`
	Payload DiffChunkPayload `json:"payload"`
}

func TestDiffFixtureChunking(t *testing.T) {
	fixtureRoot := filepath.Join("..", "..", "tests", "fixtures", "git", "diff")
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(fixtureRoot, name)
			stdout, err := os.ReadFile(filepath.Join(dir, "stdout.bin"))
			if err != nil {
				t.Fatal(err)
			}
			var fixture diffFixture
			readJSON(t, filepath.Join(dir, "expected.json"), &fixture)

			var events []diffFixtureEvent
			s := New(t.TempDir())
			s.SetEventSink(func(event string, payload any) error {
				chunk, ok := payload.(DiffChunkPayload)
				if !ok {
					t.Fatalf("unexpected payload type %T", payload)
				}
				events = append(events, diffFixtureEvent{Name: event, Payload: chunk})
				return nil
			})

			result, err := s.emitDiffChunks(context.Background(), fixture.Params.StreamID, bytes.NewReader(stdout), fixture.Params.MaxChunkBytes, fixture.Params.MaxBytes)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(result, fixture.Result) {
				t.Fatalf("result mismatch\n got: %#v\nwant: %#v", result, fixture.Result)
			}
			if !reflect.DeepEqual(events, fixture.Events) {
				t.Fatalf("events mismatch\n got: %#v\nwant: %#v", events, fixture.Events)
			}
			for _, event := range events {
				if strings.ContainsRune(event.Payload.Text, '\ufffd') {
					t.Fatalf("chunk contains replacement character: %q", event.Payload.Text)
				}
				if !utf8.ValidString(event.Payload.Text) {
					t.Fatalf("chunk is not valid UTF-8: %q", event.Payload.Text)
				}
			}
		})
	}
}

func TestDiffChunksLargeInputOverOneMiB(t *testing.T) {
	input := bytes.Repeat([]byte("a"), 1024*1024+17)
	s := New(t.TempDir())
	chunks := 0
	s.SetEventSink(func(event string, payload any) error {
		if event != "git.diff.chunk" {
			t.Fatalf("unexpected event %q", event)
		}
		chunks++
		return nil
	})
	result, err := s.emitDiffChunks(context.Background(), "", bytes.NewReader(input), defaultDiffChunkBytes, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result.Bytes != int64(len(input)) || result.Truncated {
		t.Fatalf("unexpected result: %#v", result)
	}
	if chunks != 2 {
		t.Fatalf("expected 2 chunks, got %d", chunks)
	}
}

func TestDiffArgsUseMinimalOptions(t *testing.T) {
	contextLines := 5
	unifiedLines := 2
	got := diffArgs(DiffParams{From: "main", To: "feature", Paths: []string{"a.txt"}, Context: &contextLines, Unified: &unifiedLines, Cached: true})
	want := []string{"diff", "--no-ext-diff", "--unified=2", "--cached", "main", "feature", "--", "a.txt"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestDiffRegistered(t *testing.T) {
	d := dispatch.New()
	Register(d, New(t.TempDir()))
	res := d.Dispatch(context.Background(), proto.Request{ID: "1", Method: "git.diff", Params: json.RawMessage(`{"maxChunkBytes":1}`)})
	if res.Error != nil && res.Error.Code == proto.CodeUnsupported {
		t.Fatalf("git.diff was not registered: %#v", res)
	}
}

func readJSON(t *testing.T, path string, dest any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, dest); err != nil {
		t.Fatal(err)
	}
}
