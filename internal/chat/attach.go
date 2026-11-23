package chat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const maxAttachBytes = 20 * 1024 * 1024

var attachRoot = func() (string, error) {
	root, err := agentpaths.Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "attach"), nil
}

var windowsNames = runtime.GOOS == "windows"

type AttachParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	Name        string `json:"name"`
	Data        string `json:"data"`
}

type AttachResult struct {
	Path string `json:"path"`
}

type AttachRootResult struct {
	Root string `json:"root"`
}

type PruneAttachParams struct {
	WorkspaceID string        `json:"workspaceId"`
	KeepTabIDs  []string      `json:"keepTabIds"`
	Retain      *RetainParams `json:"retain,omitempty"`
}

var errAttachFolderLinked = proto.NewError("chat.attach-folder-link", "chat.attach: the tab's attach folder is not a folder of its own")

func (s *Service) Attach(_ context.Context, raw json.RawMessage) (any, error) {
	var p AttachParams
	if err := proto.DecodeParams(raw, &p, "chat.attach params must include workspaceId, tabId, name and data"); err != nil {
		return nil, err
	}
	key, err := proto.TabKeyFrom(p.WorkspaceID, p.TabID, "chat.attach")
	if err != nil {
		return nil, err
	}
	if !slotTab.MatchString(key.TabID) {
		return nil, proto.ProtocolError("chat.attach tabId is not a tab's id")
	}
	name, ok := plainName(p.Name)
	if !ok {
		return nil, proto.ProtocolError("chat.attach name must be a file name")
	}
	if windowsNames {
		name = windowsName(name)
	}
	if base64.StdEncoding.DecodedLen(len(p.Data)) > maxAttachBytes+3 {
		return nil, proto.RequestFailed("%s is larger than %d MiB", name, maxAttachBytes>>20)
	}
	data, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return nil, proto.ProtocolError("chat.attach data must be base64")
	}
	if len(data) > maxAttachBytes {
		return nil, proto.RequestFailed("%s is larger than %d MiB", name, maxAttachBytes>>20)
	}
	dir, err := tabAttachDir(key)
	if err != nil {
		return nil, proto.RequestFailed("chat.attach: %s", proto.Reason(err))
	}
	wsDir := filepath.Dir(dir)
	if err := os.MkdirAll(filepath.Dir(wsDir), 0o700); err != nil {
		return nil, proto.RequestFailed("chat.attach: %s", proto.Reason(err))
	}
	for _, step := range []string{wsDir, dir} {
		if err := os.Mkdir(step, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, proto.RequestFailed("chat.attach: %s", proto.Reason(err))
		}
		if !realDir(step) {
			return nil, errAttachFolderLinked
		}
	}
	for n := 1; ; n++ {
		slot := filepath.Join(dir, strconv.Itoa(n))
		err := os.Mkdir(slot, 0o700)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return nil, proto.RequestFailed("chat.attach: %s", proto.Reason(err))
		}
		path := filepath.Join(slot, name)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			_ = os.RemoveAll(slot)
			return nil, proto.RequestFailed("chat.attach: %s", proto.Reason(err))
		}
		return AttachResult{Path: path}, nil
	}
}

func (s *Service) AttachRoot(_ context.Context, _ json.RawMessage) (any, error) {
	root, err := attachRoot()
	if err != nil {
		return nil, proto.RequestFailed("chat.attachRoot: %s", proto.Reason(err))
	}
	return AttachRootResult{Root: root}, nil
}

func (s *Service) PruneAttachments(_ context.Context, raw json.RawMessage) (any, error) {
	var p PruneAttachParams
	if err := proto.DecodeParams(raw, &p, "chat.pruneAttachments params must include workspaceId"); err != nil {
		return nil, err
	}
	workspaceID, ok := plainName(strings.TrimSpace(p.WorkspaceID))
	if !ok {
		return nil, proto.ProtocolError("chat.pruneAttachments workspaceId is required")
	}
	root, err := attachRoot()
	if err != nil {
		return nil, proto.RequestFailed("chat.pruneAttachments: %s", proto.Reason(err))
	}
	keep := make(map[string]bool, len(p.KeepTabIDs))
	for _, id := range p.KeepTabIDs {
		keep[strings.TrimSpace(id)] = true
	}
	dir := filepath.Join(root, workspaceID)
	if p.Retain != nil {
		if len(p.Retain.Keep) > maxAttachSlots {
			return nil, proto.ProtocolError("chat.pruneAttachments keeps too many slots")
		}
		return PruneResult{Removed: pruneRetained(dir, keep, *p.Retain, time.Now())}, nil
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return struct{}{}, nil
	}
	if err != nil {
		return nil, proto.RequestFailed("chat.pruneAttachments: %s", proto.Reason(err))
	}
	for _, entry := range entries {
		if !keep[entry.Name()] {
			_ = os.RemoveAll(filepath.Join(dir, entry.Name()))
		}
	}
	return struct{}{}, nil
}

func removeAttachments(key tabKey) {
	if dir, err := tabAttachDir(key); err == nil && realDir(filepath.Dir(dir)) {
		_ = os.RemoveAll(dir)
	}
}

func tabAttachDir(key tabKey) (string, error) {
	workspaceID, ok := plainName(key.WorkspaceID)
	if !ok {
		return "", errors.New("workspaceId is not a plain name")
	}
	tabID, ok := plainName(key.TabID)
	if !ok {
		return "", errors.New("tabId is not a plain name")
	}
	root, err := attachRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, workspaceID, tabID), nil
}

var windowsReserved = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\.|$)`)

func windowsName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(`<>:"/\|?*`, r) {
			b.WriteByte('_')
		} else {
			b.WriteRune(r)
		}
	}
	cleaned := strings.TrimRight(b.String(), ". ")
	if cleaned == "" {
		return "file"
	}
	if windowsReserved.MatchString(cleaned) {
		return "_" + cleaned
	}
	return cleaned
}

func plainName(name string) (string, bool) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return "", false
	}
	return name, true
}
