package chat

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// junction makes link a directory junction to target (mklink /J), which
// needs no privilege, unlike a symbolic link; the test skips without one.
func junction(t *testing.T, link, target string) {
	t.Helper()
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skipf("no junction here: %v %s", err, out)
	}
}

// A tab's folder, a slot's folder or the workspace's folder that is a
// junction to a folder elsewhere: no prune, touch or removal reaches what
// is there; removing the workspace's folder removes the junction alone.
func TestAttachmentCallsFollowNoJunction(t *testing.T) {
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
	if err := os.Chtimes(victim, old, old); err != nil {
		t.Fatal(err)
	}
	untouched := func(when string) {
		t.Helper()
		info, err := os.Stat(victim)
		if err != nil {
			t.Fatalf("%s: the file through a junction went: %v", when, err)
		}
		if time.Since(info.ModTime()) < time.Hour {
			t.Fatalf("%s: the file through a junction was touched", when)
		}
	}
	ws := filepath.Join(root, "ws")
	if err := os.MkdirAll(filepath.Join(ws, "tab"), 0o700); err != nil {
		t.Fatal(err)
	}
	// A tab's folder that is a junction, and a slot's folder that is one.
	junction(t, filepath.Join(ws, "linked"), outside)
	junction(t, filepath.Join(ws, "tab", "1"), filepath.Join(outside, "1"))
	ageFolders(t, ws, time.Hour)

	// Nothing is attached through a tab's junction.
	if _, err := attach(t, service, "linked", "new.txt", []byte("n")); err == nil {
		t.Fatal("a file was attached through a junction")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 1 {
		t.Fatalf("attaching wrote through a junction: %v", entries)
	}

	slots := []string{"linked/1", "tab/1"}
	slotsCallOf(t, service.TouchAttachments, SlotsParams{WorkspaceID: "ws", Slots: slots})
	untouched("touch")
	slotsCallOf(t, service.RemoveAttachments, SlotsParams{WorkspaceID: "ws", Slots: slots})
	untouched("remove")
	prune(t, service, PruneAttachParams{WorkspaceID: "ws", KeepTabIDs: []string{"tab"}, Retain: &RetainParams{Keep: slots}})
	untouched("prune keeping them")
	prune(t, service, PruneAttachParams{WorkspaceID: "ws", Retain: &RetainParams{MaxAgeMs: 1, MaxBytes: 1}})
	untouched("prune")
	prune(t, service, PruneAttachParams{WorkspaceID: "ws"})
	untouched("prune without retain")

	// Closing a tab removes its junction, or its slot's, not what is there.
	if err := os.RemoveAll(ws); err != nil {
		t.Fatal(err)
	}
	untouched("clearing the workspace's folder")
	if err := os.MkdirAll(filepath.Join(ws, "tab"), 0o700); err != nil {
		t.Fatal(err)
	}
	junction(t, filepath.Join(ws, "linked"), outside)
	junction(t, filepath.Join(ws, "tab", "1"), filepath.Join(outside, "1"))
	closeTab(t, service, "linked")
	untouched("closing a junction tab")
	if _, err := os.Lstat(filepath.Join(ws, "linked")); err == nil {
		t.Fatal("the closed tab's junction stayed")
	}
	closeTab(t, service, "tab")
	untouched("closing a tab with a junction slot")
	if _, err := os.Lstat(filepath.Join(ws, "tab")); err == nil {
		t.Fatal("the closed tab's folder stayed")
	}

	// The workspace's folder as a junction.
	if err := os.RemoveAll(ws); err != nil {
		t.Fatal(err)
	}
	untouched("clearing the workspace's folder")
	junction(t, ws, outside)
	prune(t, service, PruneAttachParams{WorkspaceID: "ws", Retain: &RetainParams{MaxAgeMs: 1}})
	untouched("prune of a junction workspace")
	if _, err := attach(t, service, "1", "new.txt", []byte("n")); err == nil {
		t.Fatal("a file was attached below a junction workspace")
	}
	closeTab(t, service, "1")
	untouched("closing a tab below a junction workspace")
	slotsCallOf(t, service.RemoveAttachments, SlotsParams{WorkspaceID: "ws", All: true})
	untouched("removing the workspace's folder")
	if _, err := os.Lstat(ws); err == nil {
		t.Fatal("the workspace's junction stayed")
	}
}
