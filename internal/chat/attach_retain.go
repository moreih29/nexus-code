package chat

// How long attached files stay (attach.go). The app tells what is in use:
// the folders of the tabs still open, and the slots their conversations
// name, which a prune keeps and marks used. Each other slot's file time is
// when it was last used, moved on by chat.touchAttachments as a
// conversation that names it is shown or sent to; a prune removes those
// unused for longer than it is told, then, past the room it is given, the
// least recently used. chat.removeAttachments removes the slots of a
// deleted conversation, or a removed workspace's folder.
//
// A slot is "<tabId>/<n>" below the workspace's folder: one folder holding
// one file. Nothing else is touched or removed by a slot's name, and no
// link is followed: a slot, its tab's folder and the workspace's folder
// must each be a folder, and the file a regular file.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// maxAttachSlots caps how many slots one call names.
const maxAttachSlots = 5000

// RetainParams is chat.pruneAttachments' retain.
type RetainParams struct {
	// Keep are the slots ("<tabId>/<n>") the open tabs' conversations name.
	Keep []string `json:"keep"`
	// MaxAgeMs is how long a slot not kept may go unused; 0 = no limit.
	MaxAgeMs int64 `json:"maxAgeMs"`
	// MaxBytes is the most the workspace's slots may hold; past it the
	// least recently used not kept go. 0 = no limit.
	MaxBytes int64 `json:"maxBytes"`
}

// PruneResult is chat.pruneAttachments' answer with retain.
type PruneResult struct {
	Removed int `json:"removed"`
}

// SlotsParams is the wire shape for chat.touchAttachments and
// chat.removeAttachments.
type SlotsParams struct {
	WorkspaceID string   `json:"workspaceId"`
	Slots       []string `json:"slots"`
	// All removes the workspace's whole folder (chat.removeAttachments).
	All bool `json:"all,omitempty"`
}

// SlotsResult tells how many slots a call touched or removed.
type SlotsResult struct {
	Count int `json:"count"`
}

// A slot is "<tabId>/<n>": a tab of at most 128 letters, digits, "_" or
// "-", and at most 9 digits, as the app reads them (attach-folders.ts). A
// name no system folds or reads more in (case aside), which fits a call.
var (
	slotTab    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	slotNumber = regexp.MustCompile(`^[0-9]{1,9}$`)
)

// TouchAttachments marks the named slots used now.
func (s *Service) TouchAttachments(_ context.Context, raw json.RawMessage) (any, error) {
	p, wsDir, err := slotsCall(raw, "chat.touchAttachments")
	if err != nil {
		return nil, err
	}
	now := time.Now()
	count := 0
	if realDir(wsDir) {
		for _, slot := range p.Slots {
			dir, ok := slotDir(wsDir, slot)
			if !ok {
				continue
			}
			if file, _, ok := slotFile(dir); ok && os.Chtimes(file, now, now) == nil {
				count++
			}
		}
	}
	return SlotsResult{Count: count}, nil
}

// RemoveAttachments removes the named slots, or the workspace's folder.
func (s *Service) RemoveAttachments(_ context.Context, raw json.RawMessage) (any, error) {
	p, wsDir, err := slotsCall(raw, "chat.removeAttachments")
	if err != nil {
		return nil, err
	}
	if p.All {
		// A link in its place goes, not what it points at.
		if _, err := os.Lstat(wsDir); err != nil {
			return SlotsResult{}, nil
		}
		if err := os.RemoveAll(wsDir); err != nil {
			return nil, requestFailed("chat.removeAttachments: %v", err)
		}
		return SlotsResult{Count: 1}, nil
	}
	count := 0
	if realDir(wsDir) {
		for _, slot := range p.Slots {
			dir, ok := slotDir(wsDir, slot)
			if !ok {
				continue
			}
			if os.RemoveAll(dir) == nil {
				count++
			}
			// The tab's folder goes with its last slot.
			_ = os.Remove(filepath.Dir(dir))
		}
	}
	return SlotsResult{Count: count}, nil
}

// slotsCall reads a call that names slots, and the workspace's folder.
func slotsCall(raw json.RawMessage, method string) (SlotsParams, string, error) {
	var p SlotsParams
	if err := decodeParams(raw, &p, method+" params must include workspaceId and slots"); err != nil {
		return p, "", err
	}
	workspaceID, ok := plainName(strings.TrimSpace(p.WorkspaceID))
	if !ok {
		return p, "", protocolError(method + " workspaceId is required")
	}
	if len(p.Slots) > maxAttachSlots {
		return p, "", protocolError(method + " names too many slots")
	}
	root, err := attachRoot()
	if err != nil {
		return p, "", requestFailed("%s: %v", method, err)
	}
	return p, filepath.Join(root, workspaceID), nil
}

// pruneRetained removes, below the workspace's folder wsDir, the slots not
// in use: those of no tab in keepTabs and not in retain.Keep that have gone
// unused longer than retain.MaxAgeMs, then the least recently used of them
// while the slots hold more than retain.MaxBytes. The slots in use are
// marked used now. A slot without its one file, which no message can name,
// goes too. It answers how many slots went.
func pruneRetained(wsDir string, keepTabs map[string]bool, retain RetainParams, now time.Time) int {
	if !realDir(wsDir) {
		return 0
	}
	keep := make(map[string]bool, len(retain.Keep))
	for _, slot := range retain.Keep {
		keep[slot] = true
	}
	maxAge := time.Duration(retain.MaxAgeMs) * time.Millisecond
	type unused struct {
		dir  string
		size int64
		used time.Time
	}
	var loose []unused
	var total int64
	removed := 0
	tabs, _ := os.ReadDir(wsDir)
	for _, tab := range tabs {
		tabDir := filepath.Join(wsDir, tab.Name())
		if !realDir(tabDir) {
			continue
		}
		openTab := keepTabs[tab.Name()]
		slots, _ := os.ReadDir(tabDir)
		for _, entry := range slots {
			slot := tab.Name() + "/" + entry.Name()
			dir, ok := slotDir(wsDir, slot)
			if !ok {
				continue
			}
			file, info, ok := slotFile(dir)
			if openTab || keep[slot] {
				if ok {
					_ = os.Chtimes(file, now, now)
					total += info.Size()
				}
				continue
			}
			if !ok || (maxAge > 0 && now.Sub(info.ModTime()) > maxAge) {
				if os.RemoveAll(dir) == nil {
					removed++
				}
				continue
			}
			total += info.Size()
			loose = append(loose, unused{dir: dir, size: info.Size(), used: info.ModTime()})
		}
		if !openTab {
			// Goes once its last slot has: an open tab may be writing one.
			_ = os.Remove(tabDir)
		}
	}
	if retain.MaxBytes > 0 && total > retain.MaxBytes {
		sort.Slice(loose, func(i, j int) bool { return loose[i].used.Before(loose[j].used) })
		for _, slot := range loose {
			if total <= retain.MaxBytes {
				break
			}
			if os.RemoveAll(slot.dir) != nil {
				continue
			}
			total -= slot.size
			removed++
			_ = os.Remove(filepath.Dir(slot.dir))
		}
	}
	return removed
}

// slotDir is the folder of slot "<tabId>/<n>" below the workspace's folder
// wsDir: none for any other name, nor where it or its tab's folder is not a
// folder of its own (a link).
func slotDir(wsDir, slot string) (string, bool) {
	tabID, n, ok := strings.Cut(slot, "/")
	if !ok || !slotTab.MatchString(tabID) || !slotNumber.MatchString(n) {
		return "", false
	}
	tabDir := filepath.Join(wsDir, tabID)
	// One segment below the workspace's folder, whatever the system reads in it.
	if filepath.Dir(tabDir) != filepath.Clean(wsDir) || filepath.Base(tabDir) != tabID {
		return "", false
	}
	dir := filepath.Join(tabDir, n)
	if !realDir(tabDir) || !realDir(dir) {
		return "", false
	}
	return dir, true
}

// slotFile is the one regular file in a slot's folder.
func slotFile(dir string) (string, os.FileInfo, bool) {
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		return "", nil, false
	}
	path := filepath.Join(dir, entries[0].Name())
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil, false
	}
	return path, info, true
}

// realDir reports whether path is a folder, not a link to one.
func realDir(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir()
}
