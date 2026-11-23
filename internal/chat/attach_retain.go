package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const maxAttachSlots = 5000

const attachGrace = 10 * time.Minute

type RetainParams struct {
	Keep     []string `json:"keep"`
	MaxAgeMs int64    `json:"maxAgeMs"`
	MaxBytes int64    `json:"maxBytes"`
}

type PruneResult struct {
	Removed int `json:"removed"`
}

type SlotsParams struct {
	WorkspaceID string   `json:"workspaceId"`
	Slots       []string `json:"slots"`
	All         bool     `json:"all,omitempty"`
}

type SlotsResult struct {
	Count int `json:"count"`
}

var (
	slotTab    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	slotNumber = regexp.MustCompile(`^[0-9]{1,9}$`)
)

func (s *Service) TouchAttachments(_ context.Context, raw json.RawMessage) (any, error) {
	p, wsDir, err := slotsCall(raw, "chat.touchAttachments")
	if err != nil {
		return nil, err
	}
	now := time.Now()
	count := 0
	if realDir(wsDir) {
		names := dirNames{}
		for _, slot := range p.Slots {
			dir, ok := slotDir(wsDir, slot, names)
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

func (s *Service) RemoveAttachments(_ context.Context, raw json.RawMessage) (any, error) {
	p, wsDir, err := slotsCall(raw, "chat.removeAttachments")
	if err != nil {
		return nil, err
	}
	if p.All {
		if _, err := os.Lstat(wsDir); err != nil {
			return SlotsResult{}, nil
		}
		if err := os.RemoveAll(wsDir); err != nil {
			return nil, proto.RequestFailed("chat.removeAttachments: %v", err)
		}
		return SlotsResult{Count: 1}, nil
	}
	count := 0
	if realDir(wsDir) {
		names := dirNames{}
		for _, slot := range p.Slots {
			dir, ok := slotDir(wsDir, slot, names)
			if !ok {
				continue
			}
			if os.RemoveAll(dir) == nil {
				count++
			}
			_ = os.Remove(filepath.Dir(dir))
		}
	}
	return SlotsResult{Count: count}, nil
}

func slotsCall(raw json.RawMessage, method string) (SlotsParams, string, error) {
	var p SlotsParams
	if err := proto.DecodeParams(raw, &p, method+" params must include workspaceId and slots"); err != nil {
		return p, "", err
	}
	workspaceID, ok := plainName(strings.TrimSpace(p.WorkspaceID))
	if !ok {
		return p, "", proto.ProtocolError(method + " workspaceId is required")
	}
	if len(p.Slots) > maxAttachSlots {
		return p, "", proto.ProtocolError(method + " names too many slots")
	}
	root, err := attachRoot()
	if err != nil {
		return p, "", proto.RequestFailed("%s: %v", method, err)
	}
	return p, filepath.Join(root, workspaceID), nil
}

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
		dir   string
		size  int64
		used  time.Time
		fresh bool
	}
	var loose []unused
	var total int64
	removed := 0
	names := dirNames{}
	tabs, _ := os.ReadDir(wsDir)
	for _, tab := range tabs {
		tabDir := filepath.Join(wsDir, tab.Name())
		if !realDir(tabDir) {
			continue
		}
		openTab := keepTabs[tab.Name()]
		fresh := changedWithin(tabDir, now, attachGrace)
		slots, _ := os.ReadDir(tabDir)
		for _, entry := range slots {
			slot := tab.Name() + "/" + entry.Name()
			dir, ok := slotDir(wsDir, slot, names)
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
			if !ok && changedWithin(dir, now, attachGrace) {
				continue
			}
			if !ok || (maxAge > 0 && now.Sub(info.ModTime()) > maxAge) {
				if os.RemoveAll(dir) == nil {
					removed++
				}
				continue
			}
			total += info.Size()
			loose = append(loose, unused{dir: dir, size: info.Size(), used: info.ModTime(), fresh: fresh})
		}
		if !openTab && !fresh {
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
			if !slot.fresh {
				_ = os.Remove(filepath.Dir(slot.dir))
			}
		}
	}
	return removed
}

func slotDir(wsDir, slot string, names dirNames) (string, bool) {
	tabID, n, ok := strings.Cut(slot, "/")
	if !ok || !slotTab.MatchString(tabID) || !slotNumber.MatchString(n) {
		return "", false
	}
	tabDir := filepath.Join(wsDir, tabID)
	if filepath.Dir(tabDir) != filepath.Clean(wsDir) || filepath.Base(tabDir) != tabID {
		return "", false
	}
	dir := filepath.Join(tabDir, n)
	if !names.has(wsDir, tabID) || !names.has(tabDir, n) || !realDir(tabDir) || !realDir(dir) {
		return "", false
	}
	return dir, true
}

type dirNames map[string]map[string]bool

func (d dirNames) has(dir, name string) bool {
	held, ok := d[dir]
	if !ok {
		held = map[string]bool{}
		entries, _ := os.ReadDir(dir)
		for _, entry := range entries {
			held[entry.Name()] = true
		}
		d[dir] = held
	}
	return held[name]
}

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

func changedWithin(path string, now time.Time, d time.Duration) bool {
	info, err := os.Lstat(path)
	return err == nil && now.Sub(info.ModTime()) < d
}

func realDir(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir()
}
