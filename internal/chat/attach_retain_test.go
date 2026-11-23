package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// attachAged attaches a file for the tab and dates it `age` ago.
func attachAged(t *testing.T, service *Service, tabID string, data []byte, age time.Duration) string {
	t.Helper()
	result, err := attach(t, service, tabID, "f.bin", data)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-age)
	if err := os.Chtimes(result.Path, at, at); err != nil {
		t.Fatal(err)
	}
	return result.Path
}

// ageFolders dates every folder below dir (and dir) `age` ago, past attachGrace.
func ageFolders(t *testing.T, dir string, age time.Duration) {
	t.Helper()
	at := time.Now().Add(-age)
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || !entry.IsDir() {
			return err
		}
		return os.Chtimes(path, at, at)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func prune(t *testing.T, service *Service, params PruneAttachParams) PruneResult {
	t.Helper()
	raw, _ := json.Marshal(params)
	result, err := service.PruneAttachments(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	return result.(PruneResult)
}

func slotsCallOf(t *testing.T, call func(context.Context, json.RawMessage) (any, error), params SlotsParams) SlotsResult {
	t.Helper()
	raw, _ := json.Marshal(params)
	result, err := call(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	return result.(SlotsResult)
}

// closeTab closes a tab of "ws" without keeping its attached files.
func closeTab(t *testing.T, service *Service, tabID string) {
	t.Helper()
	raw, _ := json.Marshal(TabParams{WorkspaceID: "ws", TabID: tabID})
	if _, err := service.CloseTab(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
}

func TestClosingATabKeepsItsAttachmentsWhenAsked(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	if _, err := attach(t, service, "tab", "a.txt", []byte("a")); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(TabParams{WorkspaceID: "ws", TabID: "tab", KeepAttachments: true})
	if _, err := service.CloseTab(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	if !exists(filepath.Join(root, "ws", "tab", "1", "a.txt")) {
		t.Fatal("the closed tab's attachment went")
	}
}

func TestPruneWithRetainKeepsWhatIsInUse(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	day := 24 * time.Hour
	openOld := attachAged(t, service, "open", []byte("o"), 90*day)
	keptOld := attachAged(t, service, "closed", []byte("k"), 90*day)
	staleOld := attachAged(t, service, "closed", []byte("s"), 31*day)
	recent := attachAged(t, service, "other", []byte("r"), 29*day)
	gone := attachAged(t, service, "gone", []byte("g"), 40*day)
	// A slot without its file names nothing.
	empty := filepath.Join(root, "ws", "other", "9")
	if err := os.Mkdir(empty, 0o700); err != nil {
		t.Fatal(err)
	}
	ageFolders(t, filepath.Join(root, "ws"), time.Hour)
	result := prune(t, service, PruneAttachParams{
		WorkspaceID: "ws",
		KeepTabIDs:  []string{"open"},
		Retain:      &RetainParams{Keep: []string{"closed/1"}, MaxAgeMs: (30 * day).Milliseconds()},
	})
	if result.Removed != 3 {
		t.Fatalf("removed %d, want 3", result.Removed)
	}
	for _, path := range []string{openOld, keptOld, recent} {
		if !exists(path) {
			t.Fatalf("%s went", path)
		}
	}
	for _, path := range []string{staleOld, gone, empty} {
		if exists(path) {
			t.Fatalf("%s stayed", path)
		}
	}
	// The emptied tab's folder goes; the ones in use are used now.
	if exists(filepath.Join(root, "ws", "gone")) {
		t.Fatal("the emptied tab's folder stayed")
	}
	for _, path := range []string{openOld, keptOld} {
		info, _ := os.Stat(path)
		if time.Since(info.ModTime()) > time.Minute {
			t.Fatalf("%s was not marked used", path)
		}
	}
	if info, _ := os.Stat(recent); time.Since(info.ModTime()) < 28*day {
		t.Fatal("a slot not in use was marked used")
	}
}

func TestPruneWithRetainMakesRoomLeastRecentlyUsedFirst(t *testing.T) {
	useAttachRoot(t)
	service := New()
	hour := time.Hour
	kept := attachAged(t, service, "a", make([]byte, 400), 10*hour)
	oldest := attachAged(t, service, "b", make([]byte, 300), 5*hour)
	older := attachAged(t, service, "b", make([]byte, 300), 4*hour)
	newest := attachAged(t, service, "c", make([]byte, 300), 1*hour)
	// 1300 bytes held, room for 1000: the two least recently used not kept go.
	result := prune(t, service, PruneAttachParams{
		WorkspaceID: "ws",
		KeepTabIDs:  []string{"a"},
		Retain:      &RetainParams{MaxBytes: 1000},
	})
	if result.Removed != 1 {
		t.Fatalf("removed %d, want 1", result.Removed)
	}
	if exists(oldest) || !exists(older) || !exists(newest) || !exists(kept) {
		t.Fatalf("kept: oldest %v older %v newest %v kept %v", exists(oldest), exists(older), exists(newest), exists(kept))
	}
	// Room for less than what is kept: everything not kept goes, what is kept stays.
	prune(t, service, PruneAttachParams{
		WorkspaceID: "ws",
		KeepTabIDs:  []string{"a"},
		Retain:      &RetainParams{MaxBytes: 100},
	})
	if exists(older) || exists(newest) || !exists(kept) {
		t.Fatal("a slot in use went, or one not stayed past the room")
	}
}

func TestPruneWithoutRetainRemovesClosedTabsAsBefore(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	attachAged(t, service, "closed", []byte("c"), time.Minute)
	raw, _ := json.Marshal(PruneAttachParams{WorkspaceID: "ws"})
	if _, err := service.PruneAttachments(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(root, "ws", "closed")) {
		t.Fatal("the closed tab's folder stayed")
	}
}

func TestTouchAttachmentsMarksSlotsUsed(t *testing.T) {
	useAttachRoot(t)
	service := New()
	path := attachAged(t, service, "tab", []byte("t"), 40*24*time.Hour)
	result := slotsCallOf(t, service.TouchAttachments, SlotsParams{
		WorkspaceID: "ws",
		Slots:       []string{"tab/1", "tab/2", "../ws/tab/1", "tab/x", "tab/-1", "tab/1/f.bin", "", "./1"},
	})
	if result.Count != 1 {
		t.Fatalf("touched %d, want 1", result.Count)
	}
	if info, _ := os.Stat(path); time.Since(info.ModTime()) > time.Minute {
		t.Fatal("the slot was not marked used")
	}
}

func TestRemoveAttachmentsRemovesOnlyNamedSlots(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	first := attachAged(t, service, "tab", []byte("1"), time.Minute)
	second := attachAged(t, service, "tab", []byte("2"), time.Minute)
	other := attachAged(t, service, "other", []byte("o"), time.Minute)
	result := slotsCallOf(t, service.RemoveAttachments, SlotsParams{
		WorkspaceID: "ws",
		Slots:       []string{"tab/1", "..", "../ws", "other", "other/1/..", "tab/9"},
	})
	if result.Count != 1 || exists(first) || !exists(second) || !exists(other) {
		t.Fatalf("count %d first %v second %v other %v", result.Count, exists(first), exists(second), exists(other))
	}
	slotsCallOf(t, service.RemoveAttachments, SlotsParams{WorkspaceID: "ws", Slots: []string{"tab/2"}})
	if exists(filepath.Join(root, "ws", "tab")) {
		t.Fatal("the emptied tab's folder stayed")
	}
	slotsCallOf(t, service.RemoveAttachments, SlotsParams{WorkspaceID: "ws", All: true})
	if exists(filepath.Join(root, "ws")) {
		t.Fatal("the workspace's folder stayed")
	}
	// Nothing to remove is no failure.
	slotsCallOf(t, service.RemoveAttachments, SlotsParams{WorkspaceID: "ws", All: true})
}

func TestAttachmentCallsFollowNoLink(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	outside := t.TempDir()
	victim := filepath.Join(outside, "1", "keep.txt")
	if err := os.MkdirAll(filepath.Dir(victim), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(victim, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-90 * 24 * time.Hour)
	_ = os.Chtimes(victim, old, old)
	if err := os.MkdirAll(filepath.Join(root, "ws"), 0o700); err != nil {
		t.Fatal(err)
	}
	// A tab's folder that is a link to a folder elsewhere.
	if err := os.Symlink(outside, filepath.Join(root, "ws", "linked")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	slotsCallOf(t, service.TouchAttachments, SlotsParams{WorkspaceID: "ws", Slots: []string{"linked/1"}})
	if info, _ := os.Stat(victim); time.Since(info.ModTime()) < time.Hour {
		t.Fatal("a file through a link was touched")
	}
	slotsCallOf(t, service.RemoveAttachments, SlotsParams{WorkspaceID: "ws", Slots: []string{"linked/1"}})
	prune(t, service, PruneAttachParams{
		WorkspaceID: "ws",
		Retain:      &RetainParams{MaxAgeMs: 1, MaxBytes: 1},
	})
	if !exists(victim) {
		t.Fatal("a file through a link was removed")
	}
	// Nothing is attached through it, and closing its tab removes the link alone.
	if _, err := attach(t, service, "linked", "new.txt", []byte("n")); err == nil {
		t.Fatal("a file was attached through a link")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 1 {
		t.Fatalf("attaching wrote through a link: %v", entries)
	}
	closeTab(t, service, "linked")
	if !exists(victim) || exists(filepath.Join(root, "ws", "linked")) {
		t.Fatalf("closing a linked tab: victim %v link %v", exists(victim), exists(filepath.Join(root, "ws", "linked")))
	}
	// The workspace's folder as a link: removing it all removes the link alone.
	if err := os.RemoveAll(filepath.Join(root, "ws")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "ws")); err != nil {
		t.Fatal(err)
	}
	prune(t, service, PruneAttachParams{WorkspaceID: "ws", Retain: &RetainParams{MaxAgeMs: 1}})
	if _, err := attach(t, service, "1", "new.txt", []byte("n")); err == nil {
		t.Fatal("a file was attached below a linked workspace")
	}
	closeTab(t, service, "1")
	slotsCallOf(t, service.RemoveAttachments, SlotsParams{WorkspaceID: "ws", All: true})
	if !exists(victim) || exists(filepath.Join(root, "ws")) {
		t.Fatalf("victim %v link %v", exists(victim), exists(filepath.Join(root, "ws")))
	}
}

func TestAttachmentCallsRefuseABadWorkspace(t *testing.T) {
	useAttachRoot(t)
	service := New()
	for _, ws := range []string{"", "..", "a/b"} {
		raw, _ := json.Marshal(SlotsParams{WorkspaceID: ws, All: true})
		if _, err := service.RemoveAttachments(context.Background(), raw); err == nil {
			t.Fatalf("workspace %q was taken", ws)
		}
	}
}

func TestAttachmentCallsNameSlotsByTheirGrammar(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	long := strings.Repeat("t", 128)
	names := []string{long + "/123456789", long + "t/1", "tab/1234567890", "tab./1", "Tab:s/1"}
	for _, name := range names {
		file := filepath.Join(root, "ws", filepath.FromSlash(name), "f.bin")
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			continue // a name this system refuses
		}
		if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	touched := slotsCallOf(t, service.TouchAttachments, SlotsParams{WorkspaceID: "ws", Slots: names})
	if touched.Count != 1 {
		t.Fatalf("touched %d, want only the longest slot name", touched.Count)
	}
	removed := slotsCallOf(t, service.RemoveAttachments, SlotsParams{WorkspaceID: "ws", Slots: names})
	if removed.Count != 1 || exists(filepath.Join(root, "ws", long)) {
		t.Fatalf("removed %d", removed.Count)
	}
	if !exists(filepath.Join(root, "ws", long+"t", "1", "f.bin")) ||
		!exists(filepath.Join(root, "ws", "tab", "1234567890", "f.bin")) {
		t.Fatal("a name past the grammar was removed")
	}
}

func TestAttachRefusesATabNoSlotCanName(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	for _, tabID := range []string{"tab.", "tab one", "t:1", strings.Repeat("a", 129), "탭"} {
		if _, err := attach(t, service, tabID, "a.txt", []byte("a")); err == nil {
			t.Errorf("attached to tab %q", tabID)
		}
	}
	if entries, _ := os.ReadDir(filepath.Join(root, "ws")); len(entries) != 0 {
		t.Fatalf("folders made: %v", entries)
	}
	if _, err := attach(t, service, strings.Repeat("a", 128), "a.txt", []byte("a")); err != nil {
		t.Fatal(err)
	}
}

func TestAttachmentCallsNameSlotsAsTheFolderWritesThem(t *testing.T) {
	useAttachRoot(t)
	service := New()
	path := attachAged(t, service, "tab", []byte("t"), 40*24*time.Hour)
	// On a system that folds case these reach tab/1; not by these names.
	other := []string{"TAB/1", "Tab/1", "tab/01"}
	touched := slotsCallOf(t, service.TouchAttachments, SlotsParams{WorkspaceID: "ws", Slots: other})
	if info, _ := os.Stat(path); touched.Count != 0 || time.Since(info.ModTime()) < time.Hour {
		t.Fatalf("touched %d by another name", touched.Count)
	}
	removed := slotsCallOf(t, service.RemoveAttachments, SlotsParams{WorkspaceID: "ws", Slots: other})
	if removed.Count != 0 || !exists(path) {
		t.Fatalf("removed %d by another name", removed.Count)
	}
	if slotsCallOf(t, service.RemoveAttachments, SlotsParams{WorkspaceID: "ws", Slots: []string{"tab/1"}}).Count != 1 {
		t.Fatal("the slot by its own name stayed")
	}
}

func TestPruneLeavesFoldersBeingAttachedTo(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	day := 24 * time.Hour
	ws := filepath.Join(root, "ws")
	// Aged: a slot without its file, and an emptied tab's folder.
	for _, dir := range []string{filepath.Join(ws, "old", "1"), filepath.Join(ws, "olden")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	stale := attachAged(t, service, "busy", []byte("s"), 40*day)
	ageFolders(t, ws, time.Hour)
	// Made after the app told which tabs are open: a tab's folder, empty
	// or with a slot whose file is not yet written.
	newTab := filepath.Join(ws, "new")
	newSlot := filepath.Join(ws, "newer", "1")
	for _, dir := range []string{newTab, newSlot} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// A slot of a busy tab goes; its folder changed just now, and stays.
	if err := os.Mkdir(filepath.Join(ws, "busy", "2"), 0o700); err != nil {
		t.Fatal(err)
	}
	result := prune(t, service, PruneAttachParams{
		WorkspaceID: "ws",
		Retain:      &RetainParams{MaxAgeMs: (30 * day).Milliseconds()},
	})
	if result.Removed != 2 || exists(stale) {
		t.Fatalf("removed %d, stale %v", result.Removed, exists(stale))
	}
	for _, path := range []string{filepath.Join(ws, "old"), filepath.Join(ws, "olden")} {
		if exists(path) {
			t.Fatalf("%s stayed past the grace", path)
		}
	}
	for _, path := range []string{newTab, newSlot, filepath.Join(ws, "busy", "2")} {
		if !exists(path) {
			t.Fatalf("%s went within the grace", path)
		}
	}
	// Past the grace, they go.
	ageFolders(t, ws, time.Hour)
	prune(t, service, PruneAttachParams{WorkspaceID: "ws", Retain: &RetainParams{MaxAgeMs: (30 * day).Milliseconds()}})
	for _, path := range []string{newTab, filepath.Join(ws, "newer"), filepath.Join(ws, "busy")} {
		if exists(path) {
			t.Fatalf("%s stayed past the grace", path)
		}
	}
}
