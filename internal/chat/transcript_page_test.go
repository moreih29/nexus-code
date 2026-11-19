package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/proto"
)

func TestTranscriptPages(t *testing.T) {
	const budget = 768
	const session = "session-for-test"
	line := func(uuid, content string) string {
		encoded, _ := json.Marshal(content)
		return `{"type":"user","uuid":"` + uuid + `","message":{"content":` + string(encoded) + `}}`
	}
	old := line("old", "처음")
	big := line("large", strings.Repeat("한<", 150))
	tip := line("recent", "최근")
	base := old + "\r\n" + big + "\r\n" + tip + "\r\n"
	withPartial := base + `{"type":`

	for _, tc := range []struct {
		name, input, change string
		retention           int64
		upTo                string
		before              []string
		want                []string
		stale               bool
	}{
		{name: "UTF-8 CRLF large row and partial tail", input: withPartial, want: []string{old, big, tip}},
		{name: "complete row at EOF", input: strings.TrimSuffix(base, "\r\n"), want: []string{old, big, tip}},
		{name: "append preserves the old end", input: withPartial, change: "append", want: []string{old, big, tip}},
		{name: "retention discards the first fragment", input: base, retention: int64(len(base) - len(old)/2), want: []string{big, tip}},
		{name: "fork ends at the first inclusive UUID", input: base + old + "\n", upTo: "old", want: []string{old}},
		{name: "resume uses the first exclusive UUID", input: base + big + "\n", before: []string{"large", "recent"}, want: []string{old}},
		{name: "truncate", input: base, change: "truncate", stale: true},
		{name: "replace at the same size", input: base, change: "replace", stale: true},
		{name: "profile mismatch", input: base, change: "profile", stale: true},
		{name: "new agent", input: base, change: "agent", stale: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			project := filepath.Join(dir, "projects", "workspace")
			if err := os.MkdirAll(project, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(project, session+".jsonl")
			write := func(path, data string) {
				if err := os.WriteFile(path, []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			write(path, tc.input)
			service := New()
			params := transcriptPageParams{TranscriptParams: TranscriptParams{SessionID: session, ConfigDir: dir}, UpTo: tc.upTo, Before: tc.before}
			retention := tc.retention
			if retention == 0 {
				retention = transcriptCapBytes
			}
			ctx := context.Background()
			page, err := service.readTranscriptPage(ctx, params, retention, budget)
			if err != nil {
				t.Fatal(err)
			}
			params.UpTo, params.Before = "", nil
			switch tc.change {
			case "append":
				write(path, tc.input+`"added"}`+"\n"+old+"\n")
			case "truncate":
				write(path, old+"\n")
			case "replace":
				write(path+".new", tc.input)
				if err := os.Rename(path+".new", path); err != nil {
					t.Fatal(err)
				}
			case "profile":
				params.ConfigDir = t.TempDir()
			case "agent":
				service = New()
			}
			if tc.stale {
				if page.Cursor == "" {
					t.Fatal("fixture did not page")
				}
				params.Cursor = page.Cursor
				_, err := service.readTranscriptPage(ctx, params, retention, budget)
				if !errors.Is(err, errStaleTranscriptCursor) {
					t.Fatalf("expected stale cursor, got %v", err)
				}
				return
			}
			var actual []string
			var fragments []byte
			snapshot := page.Snapshot
			for count := 0; ; count++ {
				if count > 16 {
					t.Fatal("cursor did not advance")
				}
				if !page.Found || page.Snapshot != snapshot || len(page.Positions) != len(page.Lines) {
					t.Fatal("page metadata changed")
				}
				wire, err := proto.MarshalFrame(proto.Success("request-id", page))
				if err != nil || len(wire) > budget {
					t.Fatalf("response length %d, %v", len(wire), err)
				}
				if page.Fragment != nil {
					fragments = append(bytes.Clone(page.Fragment.Data), fragments...)
					if page.Fragment.First {
						actual = append([]string{string(bytes.TrimSpace(fragments))}, actual...)
						fragments = nil
					}
				}
				for i := len(page.Lines) - 1; i >= 0; i-- {
					var compact bytes.Buffer
					if err := json.Compact(&compact, page.Lines[i]); err != nil {
						t.Fatal(err)
					}
					actual = append([]string{compact.String()}, actual...)
				}
				if page.Cursor == "" {
					break
				}
				params.Cursor = page.Cursor
				page, err = service.readTranscriptPage(ctx, params, retention, budget)
				if err != nil {
					t.Fatal(err)
				}
			}
			if len(fragments) != 0 || !equalRows(actual, tc.want) {
				t.Fatalf("assembled rows differ: %d vs %d", len(actual), len(tc.want))
			}
		})
	}
}

func equalRows(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i, want := range b {
		wire, _ := json.Marshal(json.RawMessage(want))
		got, _ := json.Marshal(json.RawMessage(a[i]))
		if !bytes.Equal(got, wire) {
			return false
		}
	}
	return true
}
