package chat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const namedSlack = 24 * time.Hour

const namedCacheMax = 20000

type UnnamedSlotsParams struct {
	WorkspaceID     string   `json:"workspaceId"`
	Slots           []string `json:"slots"`
	ClaudeDirs      []string `json:"claudeDirs"`
	CodexHomes      []string `json:"codexHomes"`
	ExceptThreadID  string   `json:"exceptThreadId,omitempty"`
	ExceptCodexHome string   `json:"exceptCodexHome,omitempty"`
}

type UnnamedSlotsResult struct {
	Removed int `json:"removed"`
	Kept    int `json:"kept"`
}

type namedScans struct {
	mu      sync.Mutex
	entries map[string]namedEntry
}

type namedEntry struct {
	size    int64
	mod     int64
	slots   []string
	forkOf  string
	forkEnd int64
}

type unnamedSlot struct {
	folded string
	dir    string
}

var errForkReadsDeleted = errors.New("a fork still reads the deleted conversation's history, which is gone")

func (s *Service) RemoveUnnamedAttachments(_ context.Context, raw json.RawMessage) (any, error) {
	var p UnnamedSlotsParams
	if err := proto.DecodeParams(raw, &p, "chat.removeUnnamedAttachments params must include workspaceId and slots"); err != nil {
		return nil, err
	}
	workspaceID, ok := plainName(strings.TrimSpace(p.WorkspaceID))
	if !ok {
		return nil, proto.ProtocolError("chat.removeUnnamedAttachments workspaceId is required")
	}
	if len(p.Slots) > maxAttachSlots {
		return nil, proto.ProtocolError("chat.removeUnnamedAttachments names too many slots")
	}
	if p.ExceptThreadID != "" && !sessionIDPattern.MatchString(p.ExceptThreadID) {
		return nil, proto.ProtocolError("chat.removeUnnamedAttachments exceptThreadId is not a thread id")
	}
	root, err := attachRoot()
	if err != nil {
		return nil, proto.RequestFailed("chat.removeUnnamedAttachments: %s", proto.Reason(err))
	}
	wsDir := filepath.Join(root, workspaceID)
	if !realDir(wsDir) {
		return UnnamedSlotsResult{}, nil
	}
	names := dirNames{}
	seen := map[string]bool{}
	var candidates []unnamedSlot
	var oldest time.Time
	for _, slot := range p.Slots {
		dir, ok := slotDir(wsDir, slot, names)
		if !ok || seen[dir] {
			continue
		}
		seen[dir] = true
		if born := slotBorn(dir); oldest.IsZero() || born.Before(oldest) {
			oldest = born
		}
		candidates = append(candidates, unnamedSlot{folded: foldedSlot(slot), dir: dir})
	}
	if len(candidates) == 0 {
		return UnnamedSlotsResult{}, nil
	}
	s.named.mu.Lock()
	defer s.named.mu.Unlock()
	named, err := s.named.find(wsDir, p, oldest.Add(-namedSlack))
	if err != nil {
		return nil, proto.RequestFailed("chat.removeUnnamedAttachments: no file was removed: %s", proto.Reason(err))
	}
	var result UnnamedSlotsResult
	for _, slot := range candidates {
		if named[slot.folded] {
			result.Kept++
			continue
		}
		if os.RemoveAll(slot.dir) == nil {
			result.Removed++
		}
		_ = os.Remove(filepath.Dir(slot.dir))
	}
	return result, nil
}

func (n *namedScans) find(wsDir string, p UnnamedSlotsParams, since time.Time) (map[string]bool, error) {
	named := map[string]bool{}
	take := func(slots []string) {
		for _, slot := range slots {
			named[slot] = true
		}
	}
	for _, dir := range historyDirs(p.ClaudeDirs, configDir) {
		err := eachHistory(filepath.Join(dir, "projects"), 2, since, nil, func(path string, info os.FileInfo) error {
			entry, err := n.read(path, info, wsDir, false)
			take(entry.slots)
			return err
		})
		if err != nil {
			return nil, err
		}
	}
	exceptHome := ""
	if p.ExceptThreadID != "" {
		exceptHome = filepath.Clean(codexHome(p.ExceptCodexHome))
	}
	forkEnds := map[string]int64{}
	var forkHomes []string
	for _, home := range historyDirs(p.CodexHomes, codexHome) {
		var skip func(string) bool
		if exceptHome != "" && filepath.Clean(home) == exceptHome {
			skip = func(name string) bool {
				return strings.HasPrefix(name, "rollout-") && strings.HasSuffix(name, "-"+p.ExceptThreadID+".jsonl")
			}
		}
		visit := func(path string, info os.FileInfo) error {
			entry, err := n.read(path, info, wsDir, true)
			take(entry.slots)
			if p.ExceptThreadID != "" && entry.forkOf == p.ExceptThreadID && entry.forkEnd > 0 {
				if _, ok := forkEnds[home]; !ok {
					forkHomes = append(forkHomes, home)
				}
				forkEnds[home] = max(forkEnds[home], entry.forkEnd)
			}
			return err
		}
		for _, sub := range []struct {
			name  string
			depth int
		}{{"sessions", 4}, {"archived_sessions", 1}} {
			if err := eachHistory(filepath.Join(home, sub.name), sub.depth, since, skip, visit); err != nil {
				return nil, err
			}
		}
	}
	for _, home := range forkHomes {
		path := keptRollout(home, p.ExceptThreadID)
		if path == "" {
			return nil, errForkReadsDeleted
		}
		slots, err := slotsUpTo(path, forkEnds[home], wsDir)
		if err != nil {
			return nil, err
		}
		take(slots)
	}
	return named, nil
}

func (n *namedScans) read(path string, info os.FileInfo, wsDir string, rollout bool) (namedEntry, error) {
	key := wsDir + "\x00" + path
	if entry, ok := n.entries[key]; ok && entry.size == info.Size() && entry.mod == info.ModTime().UnixNano() {
		return entry, nil
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return namedEntry{}, nil
	}
	if err != nil {
		return namedEntry{}, err
	}
	defer file.Close()
	last, err := namedSlots(file, wsDir)
	if err != nil {
		return namedEntry{}, err
	}
	entry := namedEntry{size: info.Size(), mod: info.ModTime().UnixNano()}
	for slot := range last {
		entry.slots = append(entry.slots, foldedSlot(slot))
	}
	if rollout {
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return namedEntry{}, err
		}
		entry.forkOf, entry.forkEnd = rolloutBase(file)
	}
	if n.entries == nil || len(n.entries) >= namedCacheMax {
		n.entries = map[string]namedEntry{}
	}
	n.entries[key] = entry
	return entry, nil
}

func rolloutBase(r io.Reader) (string, int64) {
	var line struct {
		Type    string `json:"type"`
		Payload struct {
			ForkedFromID string `json:"forked_from_id"`
			HistoryBase  struct {
				EndByteOffset int64 `json:"end_byte_offset"`
			} `json:"history_base"`
		} `json:"payload"`
	}
	if json.NewDecoder(r).Decode(&line) != nil || line.Type != "session_meta" {
		return "", 0
	}
	return line.Payload.ForkedFromID, line.Payload.HistoryBase.EndByteOffset
}

func slotsUpTo(path string, end int64, wsDir string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	last, err := namedSlots(io.LimitReader(file, end), wsDir)
	if err != nil {
		return nil, err
	}
	slots := make([]string, 0, len(last))
	for slot := range last {
		slots = append(slots, foldedSlot(slot))
	}
	return slots, nil
}

func eachHistory(dir string, depth int, since time.Time, skip func(string) bool, visit func(string, os.FileInfo) error) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		info, err := os.Stat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.IsDir() {
			if depth > 1 {
				if err := eachHistory(path, depth-1, since, skip, visit); err != nil {
					return err
				}
			}
			continue
		}
		if !info.Mode().IsRegular() || !strings.HasSuffix(entry.Name(), ".jsonl") || info.ModTime().Before(since) {
			continue
		}
		if skip != nil && skip(entry.Name()) {
			continue
		}
		if err := visit(path, info); err != nil {
			return err
		}
	}
	return nil
}

func historyDirs(given []string, resolve func(string) string) []string {
	if len(given) == 0 {
		given = []string{""}
	}
	seen := map[string]bool{}
	var dirs []string
	for _, dir := range given {
		resolved := resolve(dir)
		if resolved == "" || seen[filepath.Clean(resolved)] {
			continue
		}
		seen[filepath.Clean(resolved)] = true
		dirs = append(dirs, resolved)
	}
	return dirs
}

func slotBorn(dir string) time.Time {
	born := time.Now()
	if info, err := os.Lstat(dir); err == nil {
		born = info.ModTime()
	}
	if _, info, ok := slotFile(dir); ok && info.ModTime().Before(born) {
		born = info.ModTime()
	}
	return born
}

func foldedSlot(slot string) string {
	folded := []byte(slot)
	for i, c := range folded {
		if c >= 'A' && c <= 'Z' {
			folded[i] = c + 'a' - 'A'
		}
	}
	return string(folded)
}
