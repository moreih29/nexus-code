package git

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
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
	fixtureRoot := fixtureDir("diff")
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

// collectChunks runs one of the chunk emitters over input and returns the
// emitted texts, failing on any chunk that is not valid UTF-8.
func collectChunks(t *testing.T, input []byte, maxChunkBytes int, emit func(*Service, io.Reader) error) []string {
	t.Helper()
	s := New(t.TempDir())
	var chunks []string
	s.SetEventSink(func(event string, payload any) error {
		text := payload.(DiffChunkPayload).Text
		if !utf8.ValidString(text) {
			t.Fatalf("chunk is not valid UTF-8: %q", text)
		}
		chunks = append(chunks, text)
		return nil
	})
	if err := emit(s, bytes.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	return chunks
}

func TestDiffChunksKeepContentAfterInvalidUTF8(t *testing.T) {
	// A Latin-1 'é' (0xE9) early in the diff used to make the final chunk
	// stop there, silently dropping every line after it.
	latin1 := []byte("diff --git a/x b/x\n+caf\xe9 ok\n" + strings.Repeat("+line\n", 10))
	mixed := []byte("+\xed\x95\x9c\xea\xb8\x80 \xc7\xd1\xb1\xdb \U0001F642\n")
	bigInvalid := bytes.Repeat([]byte("a"), 1<<20)
	bigInvalid[len(bigInvalid)/2] = 0xff

	for _, tc := range []struct {
		name  string
		input []byte
	}{{"latin1", latin1}, {"utf8-and-cp949", mixed}, {"one-mib", bigInvalid}} {
		want := strings.ToValidUTF8(string(tc.input), "�")
		for _, maxChunk := range []int{1, 2, 3, 5, 7, 64, defaultDiffChunkBytes} {
			diff := collectChunks(t, tc.input, maxChunk, func(s *Service, r io.Reader) error {
				_, err := s.emitDiffChunks(context.Background(), "", r, maxChunk, 0)
				return err
			})
			if got := strings.Join(diff, ""); got != want {
				t.Fatalf("%s/%d: diff chunks lost content: got %d bytes, want %d", tc.name, maxChunk, len(got), len(want))
			}
			stash := collectChunks(t, tc.input, maxChunk, func(s *Service, r io.Reader) error {
				_, err := s.emitStashChunks(context.Background(), "", r, maxChunk)
				return err
			})
			if got := strings.Join(stash, ""); got != want {
				t.Fatalf("%s/%d: stash chunks lost content: got %d bytes, want %d", tc.name, maxChunk, len(got), len(want))
			}
		}
	}
}

func TestDiffChunksTruncationDropsSplitCharacter(t *testing.T) {
	input := []byte("+caf\xc3\xa9\n")
	chunks := collectChunks(t, input, 64, func(s *Service, r io.Reader) error {
		result, err := s.emitDiffChunks(context.Background(), "", r, 64, 5)
		if err == nil && !result.Truncated {
			t.Fatalf("expected truncated result: %#v", result)
		}
		return err
	})
	if got := strings.Join(chunks, ""); got != "+caf" {
		t.Fatalf("truncated text = %q, want %q", got, "+caf")
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
