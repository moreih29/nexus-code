package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func historySlotsOf(t *testing.T, params HistorySlotsParams) HistorySlotsResult {
	t.Helper()
	raw, _ := json.Marshal(params)
	result, err := New().HistorySlots(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	return result.(HistorySlotsResult)
}

func writeHistory(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// jsonText is s as a JSON string's body, as a history writes it.
func jsonText(s string) string {
	b, _ := json.Marshal(s)
	return string(b[1 : len(b)-1])
}

func TestHistorySlotsReadsAClaudeTranscriptWhole(t *testing.T) {
	root := useAttachRoot(t)
	config := t.TempDir()
	ws := filepath.Join(root, "ws")
	session := "11111111-aaaa-4aaa-8aaa-111111111111"
	big := strings.Repeat("x", 3*historyChunk) // a line far past any line buffer
	writeHistory(t, filepath.Join(config, "projects", "-repo", session+".jsonl"),
		`{"type":"user","message":{"content":"look\n\n@`+jsonText(filepath.Join(ws, "early", "1", "a.png"))+`"}}`,
		`{"type":"user","message":{"content":[{"type":"image","source":{"data":"`+big+`"}}]}}`,
		// A tool's answer names one too: kept as well.
		`{"type":"user","message":{"content":[{"type":"tool_result","content":"`+jsonText(filepath.Join(ws, "tool", "2", "b.txt"))+`"}]}}`,
		// Again, later: it counts where it was last named.
		`{"type":"user","message":{"content":"@`+jsonText(filepath.Join(ws, "early", "1", "a.png"))+`"}}`,
		// Not slots: another workspace, a folder of a tab, a name past the grammar.
		`{"x":"`+jsonText(filepath.Join(root, "ws2", "t", "1", "c.png"))+`"}`,
		`{"x":"`+jsonText(filepath.Join(ws, "t", "d.png"))+`"}`,
		`{"x":"`+jsonText(filepath.Join(ws, strings.Repeat("t", 129), "1", "e.png"))+`"}`,
		`{"x":"`+jsonText(filepath.Join(ws, "t", "1234567890", "f.png"))+`"}`,
	)
	got := historySlotsOf(t, HistorySlotsParams{WorkspaceID: "ws", SessionID: session, ConfigDir: config})
	want := []string{"tool/2", "early/1"}
	if !got.Found || got.Truncated || !reflect.DeepEqual(got.Slots, want) {
		t.Fatalf("got %+v, want %v", got, want)
	}
	// No such session: none, not found.
	none := historySlotsOf(t, HistorySlotsParams{WorkspaceID: "ws", SessionID: "22222222-bbbb-4bbb-8bbb-222222222222", ConfigDir: config})
	if none.Found || len(none.Slots) != 0 || none.Slots == nil {
		t.Fatalf("got %+v", none)
	}
}

func TestHistorySlotsReadsACodexRollout(t *testing.T) {
	root := useAttachRoot(t)
	home := t.TempDir()
	thread := "019a0000-0000-7000-8000-000000000001"
	ws := filepath.Join(root, "ws")
	writeHistory(t, filepath.Join(home, "sessions", "2026", "11", "01", "rollout-2026-11-01T10-00-00-"+thread+".jsonl"),
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"@`+jsonText(filepath.Join(ws, "codex-tab", "3", "a.png"))+`"}]}}`,
	)
	got := historySlotsOf(t, HistorySlotsParams{WorkspaceID: "ws", ThreadID: thread, CodexHome: home})
	if !got.Found || !reflect.DeepEqual(got.Slots, []string{"codex-tab/3"}) {
		t.Fatalf("got %+v", got)
	}
}

func TestHistorySlotsFindsAWindowsHomeAsWritten(t *testing.T) {
	ws := `C:\Users\Me\.nexus-code\attach\ws`
	path := filepath.Join(t.TempDir(), "h.jsonl")
	writeHistory(t, path,
		// JSON-escaped backslashes, as a rollout or transcript writes them.
		`{"t":"@C:\\Users\\Me\\.nexus-code\\attach\\ws\\a\\1\\x.png"}`,
		// Slashes, a drive letter in another case, as the app writes a path.
		`{"t":"@c:/users/me/.nexus-code/attach/ws/b/2/y.png"}`,
		// Slashes JSON-escaped.
		`{"t":"@C:\/Users\/Me\/.nexus-code\/attach\/ws\/c\/3\/z.png"}`,
	)
	slots, truncated, err := historySlots(path, ws)
	if err != nil || truncated || !reflect.DeepEqual(slots, []string{"a/1", "b/2", "c/3"}) {
		t.Fatalf("slots %v truncated %v err %v", slots, truncated, err)
	}
}

func TestHistorySlotsKeepsTheLastNamedPastTheCap(t *testing.T) {
	ws := "/home/u/.nexus-code/attach/ws"
	lines := make([]string, 0, maxAttachSlots+10)
	for i := 1; i <= maxAttachSlots+10; i++ {
		lines = append(lines, fmt.Sprintf(`{"t":"@%s/t/%d/f.png"}`, ws, i))
	}
	path := filepath.Join(t.TempDir(), "h.jsonl")
	writeHistory(t, path, lines...)
	slots, truncated, err := historySlots(path, ws)
	if err != nil || !truncated || len(slots) != maxAttachSlots || slots[0] != "t/11" {
		t.Fatalf("len %d first %v truncated %v err %v", len(slots), slots[:1], truncated, err)
	}
}

func TestHistorySlotsRefusesBadParams(t *testing.T) {
	useAttachRoot(t)
	for _, params := range []HistorySlotsParams{
		{WorkspaceID: "../ws", SessionID: "11111111-aaaa-4aaa-8aaa-111111111111"},
		{WorkspaceID: "ws"},
		{WorkspaceID: "ws", SessionID: "11111111-aaaa-4aaa-8aaa-111111111111", ThreadID: "11111111-aaaa-4aaa-8aaa-111111111111"},
		{WorkspaceID: "ws", SessionID: "../x*"},
		{WorkspaceID: "ws", ThreadID: "*"},
	} {
		raw, _ := json.Marshal(params)
		if _, err := New().HistorySlots(context.Background(), raw); err == nil {
			t.Fatalf("%+v was taken", params)
		}
	}
}

func TestHistorySlotsReadsANameAcrossChunks(t *testing.T) {
	ws := "/home/u/.nexus-code/attach/ws"
	path := filepath.Join(t.TempDir(), "h.jsonl")
	for _, at := range []int{historyChunk - 10, historyChunk - len(ws) - 3, 2*historyChunk - 1} {
		name := ws + "/tab-x/7/f.png"
		writeHistory(t, path, strings.Repeat("y", at)+name)
		slots, _, err := historySlots(path, ws)
		if err != nil || !reflect.DeepEqual(slots, []string{"tab-x/7"}) {
			t.Fatalf("at %d: slots %v err %v", at, slots, err)
		}
	}
}
