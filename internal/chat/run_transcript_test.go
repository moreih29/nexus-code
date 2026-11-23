package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func runTranscriptRead(t *testing.T, service *Service, dir, id string, from *int64) RunTranscriptResult {
	t.Helper()
	params, _ := json.Marshal(RunTranscriptParams{SessionID: id, ConfigDir: dir, From: from})
	result, err := service.RunTranscript(context.Background(), params)
	if err != nil {
		t.Fatalf("RunTranscript: %v", err)
	}
	return result.(RunTranscriptResult)
}

func lineTexts(lines []json.RawMessage) string {
	texts := make([]string, len(lines))
	for i, line := range lines {
		texts[i] = string(line)
	}
	return strings.Join(texts, ",")
}

func TestRunTranscriptReadsOnFromWhereItEnded(t *testing.T) {
	dir := t.TempDir()
	project := filepath.Join(dir, "projects", "-repo")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	id := "0b6a3c2e-6f1e-4a59-9d0e-2f6d7c1a8b90"
	path := filepath.Join(project, id+".jsonl")
	service := New()

	if got := runTranscriptRead(t, service, dir, id, nil); got.Found || len(got.Lines) != 0 {
		t.Fatalf("before the file: %+v", got)
	}

	// A line still being written is left for the next read.
	if err := os.WriteFile(path, []byte(`{"n":1}`+"\n"+"junk\n"+`{"n":2`), 0o644); err != nil {
		t.Fatal(err)
	}
	first := runTranscriptRead(t, service, dir, id, nil)
	if !first.Found || lineTexts(first.Lines) != `{"n":1}` || first.Next != int64(len(`{"n":1}`+"\n"+"junk\n")) ||
		first.Reset || first.Truncated {
		t.Fatalf("first = %+v", first)
	}

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.WriteString("}\n" + `{"n":3}` + "\n")
	_ = file.Close()
	next := runTranscriptRead(t, service, dir, id, &first.Next)
	if lineTexts(next.Lines) != `{"n":2},{"n":3}` || next.Reset {
		t.Fatalf("next = %+v", next)
	}
	same := runTranscriptRead(t, service, dir, id, &next.Next)
	if len(same.Lines) != 0 || same.Next != next.Next {
		t.Fatalf("nothing new = %+v", same)
	}

	// A file shorter than where the last read ended is read again whole.
	if err := os.WriteFile(path, []byte(`{"n":9}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	again := runTranscriptRead(t, service, dir, id, &next.Next)
	if !again.Reset || lineTexts(again.Lines) != `{"n":9}` || again.Next != 8 {
		t.Fatalf("again = %+v", again)
	}

	params, _ := json.Marshal(RunTranscriptParams{SessionID: "../../etc/passwd", ConfigDir: dir})
	if _, err := service.RunTranscript(context.Background(), params); err == nil {
		t.Fatal("RunTranscript took a path for a session id")
	}
	negative := int64(-1)
	params, _ = json.Marshal(RunTranscriptParams{SessionID: id, ConfigDir: dir, From: &negative})
	if _, err := service.RunTranscript(context.Background(), params); err == nil {
		t.Fatal("RunTranscript took a negative place")
	}
}

func TestRunTranscriptKeepsTheLastLinesPastTheCap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.jsonl")
	content := `{"n":1}` + "\n" + `{"n":2}` + "\n" + `{"n":3}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	// The cut falls inside the second line: the third is kept.
	got, err := readRunTranscript(path, nil, 12)
	if err != nil || !got.Truncated || lineTexts(got.Lines) != `{"n":3}` || got.Next != int64(len(content)) {
		t.Fatalf("cut inside = %+v, %v", got, err)
	}
	// The cut falls on a line's start: that line is kept.
	got, err = readRunTranscript(path, nil, 16)
	if err != nil || !got.Truncated || lineTexts(got.Lines) != `{"n":2},{"n":3}` {
		t.Fatalf("cut on a start = %+v, %v", got, err)
	}
	// Read on from a place, more than the cap since.
	from := int64(0)
	got, err = readRunTranscript(path, &from, 12)
	if err != nil || !got.Truncated || got.Reset || lineTexts(got.Lines) != `{"n":3}` {
		t.Fatalf("from = %+v, %v", got, err)
	}
}
