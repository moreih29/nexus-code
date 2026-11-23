package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	parentThread = "019a0000-0000-7000-8000-00000000000a"
	forkThread   = "019a0000-0000-7000-8000-00000000000b"
	parentClaude = "11111111-aaaa-4aaa-8aaa-11111111111a"
	forkClaude   = "11111111-aaaa-4aaa-8aaa-11111111111b"
)

type namedSetup struct {
	root   string
	ws     string
	claude string
	codex  string
	slots  map[string]string
}

func newNamedSetup(t *testing.T, slots ...string) namedSetup {
	t.Helper()
	root := useAttachRoot(t)
	service := New()
	made := namedSetup{root: root, ws: filepath.Join(root, "ws"), claude: t.TempDir(), codex: t.TempDir(), slots: map[string]string{}}
	for _, slot := range slots {
		tab, _, _ := strings.Cut(slot, "/")
		result, err := attach(t, service, tab, "f.png", []byte(slot))
		if err != nil {
			t.Fatal(err)
		}
		made.slots[slot] = result.Path
	}
	return made
}

func (n namedSetup) params(slots ...string) UnnamedSlotsParams {
	return UnnamedSlotsParams{WorkspaceID: "ws", Slots: slots, ClaudeDirs: []string{n.claude}, CodexHomes: []string{n.codex}}
}

func (n namedSetup) mention(slot string) string {
	return "@" + jsonText(n.slots[slot])
}

func (n namedSetup) rollout(thread string) string {
	return filepath.Join(n.codex, "sessions", "2026", "11", "20", "rollout-2026-11-20T10-00-00-"+thread+".jsonl")
}

func (n namedSetup) transcript(session string) string {
	return filepath.Join(n.claude, "projects", "-repo", session+".jsonl")
}

func (n namedSetup) left(t *testing.T) []string {
	t.Helper()
	var kept []string
	for slot, path := range n.slots {
		if _, err := os.Stat(path); err == nil {
			kept = append(kept, slot)
		}
	}
	sort.Strings(kept)
	return kept
}

func userLine(text string) string {
	return `{"type":"user","message":{"role":"user","content":"` + text + `"}}`
}

func codexUserLine(text string) string {
	return `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"` + text + `"}]}}`
}

func forkMeta(thread, parent string, end int64) string {
	return `{"type":"session_meta","payload":{"id":"` + thread + `","forked_from_id":"` + parent + `","history_base":{"end_byte_offset":` + strconv.FormatInt(end, 10) + `}}}`
}

func removeUnnamed(t *testing.T, params UnnamedSlotsParams) (UnnamedSlotsResult, error) {
	t.Helper()
	raw, _ := json.Marshal(params)
	result, err := New().RemoveUnnamedAttachments(context.Background(), raw)
	if err != nil {
		return UnnamedSlotsResult{}, err
	}
	return result.(UnnamedSlotsResult), nil
}

func TestDeletingAParentKeepsWhatItsClosedCodexForkNames(t *testing.T) {
	n := newNamedSetup(t, "tab-a/1", "tab-a/2", "tab-b/1")
	writeHistory(t, n.rollout(forkThread),
		`{"type":"session_meta","payload":{"id":"`+forkThread+`","forked_from_id":"`+parentThread+`"}}`,
		codexUserLine("look "+n.mention("tab-a/1")),
	)
	params := n.params("tab-a/1", "tab-a/2", "tab-b/1")
	params.ExceptThreadID, params.ExceptCodexHome = parentThread, n.codex
	got, err := removeUnnamed(t, params)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"tab-a/1"}; !reflect.DeepEqual(n.left(t), want) || got.Removed != 2 || got.Kept != 1 {
		t.Fatalf("left %v, result %+v", n.left(t), got)
	}
}

func TestDeletingAParentKeepsWhatItsClosedClaudeForkNames(t *testing.T) {
	n := newNamedSetup(t, "tab-a/1", "tab-a/2")
	writeHistory(t, n.transcript(forkClaude),
		userLine("look "+n.mention("tab-a/1")),
		userLine("second message"),
	)
	if _, err := removeUnnamed(t, n.params("tab-a/1", "tab-a/2")); err != nil {
		t.Fatal(err)
	}
	if want := []string{"tab-a/1"}; !reflect.DeepEqual(n.left(t), want) {
		t.Fatalf("left %v", n.left(t))
	}
}

func TestDeletingAForkKeepsWhatItsParentNames(t *testing.T) {
	n := newNamedSetup(t, "tab-a/1", "tab-c/1")
	writeHistory(t, n.transcript(parentClaude), userLine("look "+n.mention("tab-a/1")))
	if _, err := removeUnnamed(t, n.params("tab-a/1", "tab-c/1")); err != nil {
		t.Fatal(err)
	}
	if want := []string{"tab-a/1"}; !reflect.DeepEqual(n.left(t), want) {
		t.Fatalf("left %v", n.left(t))
	}
}

func TestASlotNoConversationNamesIsRemoved(t *testing.T) {
	n := newNamedSetup(t, "tab-a/1", "tab-a/2")
	writeHistory(t, n.transcript(forkClaude), userLine("nothing attached here"))
	writeHistory(t, n.rollout(forkThread), codexUserLine("nor here"))
	got, err := removeUnnamed(t, n.params("tab-a/1", "tab-a/2"))
	if err != nil {
		t.Fatal(err)
	}
	if len(n.left(t)) != 0 || got.Removed != 2 {
		t.Fatalf("left %v, result %+v", n.left(t), got)
	}
	if _, err := os.Stat(filepath.Join(n.ws, "tab-a")); !os.IsNotExist(err) {
		t.Fatalf("the emptied tab folder stayed: %v", err)
	}
}

func TestTheDeletedThreadsOwnRolloutDoesNotKeepItsSlots(t *testing.T) {
	n := newNamedSetup(t, "tab-a/1")
	writeHistory(t, n.rollout(parentThread), codexUserLine(n.mention("tab-a/1")))
	writeHistory(t, filepath.Join(n.codex, "archived_sessions", "rollout-2026-11-20T10-00-00-"+parentThread+".jsonl"), codexUserLine(n.mention("tab-a/1")))
	params := n.params("tab-a/1")
	params.ExceptThreadID, params.ExceptCodexHome = parentThread, n.codex
	if _, err := removeUnnamed(t, params); err != nil {
		t.Fatal(err)
	}
	if len(n.left(t)) != 0 {
		t.Fatalf("left %v", n.left(t))
	}
	other := t.TempDir()
	n2 := newNamedSetup(t, "tab-a/1")
	writeHistory(t, filepath.Join(other, "sessions", "nexus-staged", "rollout-2026-11-20T10-00-00-"+parentThread+".jsonl"), codexUserLine(n2.mention("tab-a/1")))
	params = n2.params("tab-a/1")
	params.CodexHomes = []string{n2.codex, other}
	params.ExceptThreadID, params.ExceptCodexHome = parentThread, n2.codex
	if _, err := removeUnnamed(t, params); err != nil {
		t.Fatal(err)
	}
	if want := []string{"tab-a/1"}; !reflect.DeepEqual(n2.left(t), want) {
		t.Fatalf("a copy in another profile is a conversation that stays: left %v", n2.left(t))
	}
}

func TestACodexForkThatReadsItsParentsHistoryKeepsWhatThatHistoryNames(t *testing.T) {
	n := newNamedSetup(t, "tab-a/1", "tab-a/2")
	before := codexUserLine("look "+n.mention("tab-a/1")) + "\n"
	writeHistory(t, n.rollout(parentThread),
		strings.TrimSuffix(before, "\n"),
		codexUserLine("after the fork "+n.mention("tab-a/2")),
	)
	writeHistory(t, n.rollout(forkThread),
		forkMeta(forkThread, parentThread, int64(len(before))),
		codexUserLine("only new turns here"),
	)
	params := n.params("tab-a/1", "tab-a/2")
	params.ExceptThreadID, params.ExceptCodexHome = parentThread, n.codex
	if _, err := removeUnnamed(t, params); err != nil {
		t.Fatal(err)
	}
	if want := []string{"tab-a/1"}; !reflect.DeepEqual(n.left(t), want) {
		t.Fatalf("left %v", n.left(t))
	}
}

func TestACodexForkWhoseParentHistoryIsGoneRemovesNothing(t *testing.T) {
	n := newNamedSetup(t, "tab-a/1")
	writeHistory(t, n.rollout(forkThread), forkMeta(forkThread, parentThread, 400), codexUserLine("only new turns here"))
	params := n.params("tab-a/1")
	params.ExceptThreadID, params.ExceptCodexHome = parentThread, n.codex
	if _, err := removeUnnamed(t, params); err == nil {
		t.Fatal("removed with a fork that still reads the deleted history")
	}
	if want := []string{"tab-a/1"}; !reflect.DeepEqual(n.left(t), want) {
		t.Fatalf("left %v", n.left(t))
	}
}

func TestAHistoryThatCannotBeReadRemovesNothing(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("file modes do not keep this user out here")
	}
	for _, shut := range []string{"file", "project folder", "sessions folder"} {
		t.Run(shut, func(t *testing.T) {
			n := newNamedSetup(t, "tab-a/1")
			writeHistory(t, n.transcript(forkClaude), userLine("nothing named"))
			writeHistory(t, n.rollout(forkThread), codexUserLine("nothing named"))
			target := map[string]string{
				"file":            n.transcript(forkClaude),
				"project folder":  filepath.Dir(n.transcript(forkClaude)),
				"sessions folder": filepath.Join(n.codex, "sessions", "2026"),
			}[shut]
			if err := os.Chmod(target, 0); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(target, 0o700) })
			if _, err := removeUnnamed(t, n.params("tab-a/1")); err == nil {
				t.Fatal("removed though a history could not be read")
			}
			if want := []string{"tab-a/1"}; !reflect.DeepEqual(n.left(t), want) {
				t.Fatalf("left %v", n.left(t))
			}
		})
	}
}

func TestAHistoryOlderThanTheAttachmentIsNotRead(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("file modes do not keep this user out here")
	}
	n := newNamedSetup(t, "tab-a/1")
	old := n.transcript(forkClaude)
	writeHistory(t, old, userLine("from long before"))
	at := time.Now().Add(-72 * time.Hour)
	if err := os.Chtimes(old, at, at); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(old, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(old, 0o600) })
	if _, err := removeUnnamed(t, n.params("tab-a/1")); err != nil {
		t.Fatal(err)
	}
	if len(n.left(t)) != 0 {
		t.Fatalf("left %v", n.left(t))
	}
}

func TestMissingHistoryFoldersAreNoConversations(t *testing.T) {
	n := newNamedSetup(t, "tab-a/1")
	params := n.params("tab-a/1")
	params.ClaudeDirs = []string{filepath.Join(n.claude, "none")}
	params.CodexHomes = []string{filepath.Join(n.codex, "none")}
	if _, err := removeUnnamed(t, params); err != nil {
		t.Fatal(err)
	}
	if len(n.left(t)) != 0 {
		t.Fatalf("left %v", n.left(t))
	}
}

func TestANameInAnotherCaseIsTheSameSlot(t *testing.T) {
	n := newNamedSetup(t, "tab-a/1")
	writeHistory(t, n.transcript(forkClaude), userLine("@"+jsonText(strings.ToUpper(n.slots["tab-a/1"]))))
	if _, err := removeUnnamed(t, n.params("tab-a/1")); err != nil {
		t.Fatal(err)
	}
	if want := []string{"tab-a/1"}; !reflect.DeepEqual(n.left(t), want) {
		t.Fatalf("left %v", n.left(t))
	}
}

func TestNamedSlotsReadsWindowsPathsAsTheSameSlot(t *testing.T) {
	for _, c := range []struct {
		ws    string
		lines []string
		want  []string
	}{
		{
			ws: `C:\Users\Me\.nexus-code\attach\ws`,
			lines: []string{
				`{"t":"@C:\\Users\\Me\\.nexus-code\\attach\\ws\\a\\1\\x.png"}`,
				`{"t":"@c:/users/me/.nexus-code/attach/ws/b/2/y.png"}`,
				`{"t":"@C:\/Users\/Me\/.nexus-code\/attach\/ws\/c\/3\/z.png"}`,
				`{"out":"` + jsonText(`{"file":"`+jsonText(`C:\Users\Me\.nexus-code\attach\ws\d\4\w.png`)+`"}`) + `"}`,
				`{"t":"@C:\\Users\\Me/.nexus-code\\attach/ws\\e/5\\v.png"}`,
				`{"t":"@\\\\?\\C:\\USERS\\ME\\.NEXUS-CODE\\ATTACH\\WS\\F\\6\\u.png"}`,
				`{"t":"@C:\\Users\\Me\\\\.nexus-code\\attach\\ws\\\\g\\7\\t.png"}`,
			},
			want: []string{"a/1", "b/2", "c/3", "d/4", "e/5", "F/6", "g/7"},
		},
		{
			ws: `\\server\share\u\.nexus-code\attach\ws`,
			lines: []string{
				`{"t":"@\\\\server\\share\\u\\.nexus-code\\attach\\ws\\a\\1\\x.png"}`,
				`{"t":"@//SERVER/share/u/.nexus-code/attach/ws/b/2/y.png"}`,
				`{"t":"@\\\\?\\UNC\\server\\share\\u\\.nexus-code\\attach\\ws\\c\\3\\z.png"}`,
			},
			want: []string{"a/1", "b/2", "c/3"},
		},
	} {
		named, err := namedSlots(strings.NewReader(strings.Join(c.lines, "\n")), c.ws)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for slot := range named {
			got = append(got, slot)
		}
		sort.Strings(got)
		sort.Strings(c.want)
		if !reflect.DeepEqual(got, c.want) {
			t.Fatalf("%s: got %v, want %v", c.ws, got, c.want)
		}
	}
}

func TestRemoveUnnamedRefusesBadParams(t *testing.T) {
	useAttachRoot(t)
	many := make([]string, maxAttachSlots+1)
	for i := range many {
		many[i] = "t/" + strconv.Itoa(i)
	}
	for _, params := range []UnnamedSlotsParams{
		{WorkspaceID: "../ws", Slots: []string{"t/1"}},
		{WorkspaceID: "ws", Slots: many},
		{WorkspaceID: "ws", Slots: []string{"t/1"}, ExceptThreadID: "../x"},
	} {
		raw, _ := json.Marshal(params)
		if _, err := New().RemoveUnnamedAttachments(context.Background(), raw); err == nil {
			t.Fatalf("%+v was taken", params.ExceptThreadID)
		}
	}
}
