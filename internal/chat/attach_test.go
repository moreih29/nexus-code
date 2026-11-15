package chat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func useAttachRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	prev := attachRoot
	attachRoot = func() (string, error) { return root, nil }
	t.Cleanup(func() { attachRoot = prev })
	return root
}

func attach(t *testing.T, service *Service, tabID, name string, data []byte) (AttachResult, error) {
	t.Helper()
	raw, _ := json.Marshal(AttachParams{
		WorkspaceID: "ws",
		TabID:       tabID,
		Name:        name,
		Data:        base64.StdEncoding.EncodeToString(data),
	})
	result, err := service.Attach(context.Background(), raw)
	if err != nil {
		return AttachResult{}, err
	}
	return result.(AttachResult), nil
}

func TestAttachWritesEachFileInAFolderOfItsOwn(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	first, err := attach(t, service, "tab", "notes.md", []byte("one"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := attach(t, service, "tab", "notes.md", []byte("two"))
	if err != nil {
		t.Fatal(err)
	}
	if first.Path != filepath.Join(root, "ws", "tab", "1", "notes.md") ||
		second.Path != filepath.Join(root, "ws", "tab", "2", "notes.md") {
		t.Fatalf("paths: %s, %s", first.Path, second.Path)
	}
	if data, _ := os.ReadFile(second.Path); string(data) != "two" {
		t.Fatalf("second file holds %q", data)
	}
}

func TestAttachRefusesNamesWithAFolder(t *testing.T) {
	useAttachRoot(t)
	service := New()
	for _, name := range []string{"", ".", "..", "../x", "a/b", `a\b`} {
		if _, err := attach(t, service, "tab", name, []byte("x")); err == nil {
			t.Errorf("name %q was taken", name)
		}
	}
	if _, err := attach(t, service, "../tab", "x", []byte("x")); err == nil {
		t.Error("a tab id with a folder was taken")
	}
}

func TestWindowsNameKeepsWhatWindowsCanKeep(t *testing.T) {
	for name, want := range map[string]string{
		"report.pdf":    "report.pdf",
		".env":          ".env",
		`a?b*c|d<e>f"g`: "a_b_c_d_e_f_g",
		"a:b.txt":       "a_b.txt",
		"tab\there":     "tab_here",
		"notes. . ":     "notes",
		"...":           "file",
		"NUL":           "_NUL",
		"nul.txt":       "_nul.txt",
		"Con":           "_Con",
		"COM1.log":      "_COM1.log",
		"lpt9":          "_lpt9",
		"aux .pdf":      "_aux .pdf",
		"conout$":       "_conout$",
		"console.log":   "console.log",
		"nullable.ts":   "nullable.ts",
		"com10.txt":     "com10.txt",
		"보고서 (최종).hwp":  "보고서 (최종).hwp",
	} {
		if got := windowsName(name); got != want {
			t.Errorf("windowsName(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestAttachWritesUnderTheWindowsNameThere(t *testing.T) {
	root := useAttachRoot(t)
	prev := windowsNames
	windowsNames = true
	t.Cleanup(func() { windowsNames = prev })
	service := New()
	got, err := attach(t, service, "tab", "a:b?.txt", []byte("x"))
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if want := filepath.Join(root, "ws", "tab", "1", "a_b_.txt"); got.Path != want {
		t.Fatalf("path = %q, want %q", got.Path, want)
	}
	if data, err := os.ReadFile(got.Path); err != nil || string(data) != "x" {
		t.Fatalf("read %q: %q, %v", got.Path, data, err)
	}
}

func TestAttachLeavesNoFolderWhenTheWriteFails(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	// Longer than any file system here takes for one name.
	name := strings.Repeat("a", 300) + ".txt"
	if _, err := attach(t, service, "tab", name, []byte("x")); err == nil {
		t.Fatal("a name too long was written")
	}
	entries, err := os.ReadDir(filepath.Join(root, "ws", "tab"))
	if err != nil {
		t.Fatalf("read tab folder: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("left behind: %v", entries)
	}
}

func TestClosingATabRemovesItsAttachments(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	if _, err := attach(t, service, "tab", "a.txt", []byte("a")); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(TabParams{WorkspaceID: "ws", TabID: "tab"})
	if _, err := service.CloseTab(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "ws", "tab")); !os.IsNotExist(err) {
		t.Fatalf("the tab's folder is still there: %v", err)
	}
}

func TestPruneKeepsTheOpenTabsAttachments(t *testing.T) {
	root := useAttachRoot(t)
	service := New()
	for _, tab := range []string{"open", "closed"} {
		if _, err := attach(t, service, tab, "a.txt", []byte("a")); err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := json.Marshal(PruneAttachParams{WorkspaceID: "ws", KeepTabIDs: []string{"open"}})
	if _, err := service.PruneAttachments(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "ws", "open")); err != nil {
		t.Fatalf("the open tab's folder went: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "ws", "closed")); !os.IsNotExist(err) {
		t.Fatalf("the closed tab's folder is still there: %v", err)
	}
	// A workspace with nothing attached prunes nothing.
	raw, _ = json.Marshal(PruneAttachParams{WorkspaceID: "other"})
	if _, err := service.PruneAttachments(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
}
