package chat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

// Files the user attaches to a Claude tab's message are sent to the agent
// when the program cannot read them where they are: on an SSH host, a
// file on the user's machine. The agent keeps each under
// ~/.nexus-code/attach/<workspaceId>/<tabId>/<n>/<name>, the message names
// that path, and the tab's folder goes when the tab closes.

// maxAttachBytes caps one attached file. It travels as one line on the
// agent's channel.
const maxAttachBytes = 20 * 1024 * 1024

// attachRoot is where attached files are kept; tests point it elsewhere.
var attachRoot = func() (string, error) {
	root, err := agentpaths.Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "attach"), nil
}

// AttachParams is the wire shape for chat.attach.
type AttachParams struct {
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	// Name is the file's name, without a folder.
	Name string `json:"name"`
	// Data is the file's bytes, base64.
	Data string `json:"data"`
}

// AttachResult is returned by chat.attach: where the file was written.
type AttachResult struct {
	Path string `json:"path"`
}

// PruneAttachParams is the wire shape for chat.pruneAttachments.
type PruneAttachParams struct {
	WorkspaceID string `json:"workspaceId"`
	// KeepTabIDs are the workspace's Claude tabs still open.
	KeepTabIDs []string `json:"keepTabIds"`
}

// Attach writes one file for a tab's message and returns its path.
func (s *Service) Attach(_ context.Context, raw json.RawMessage) (any, error) {
	var p AttachParams
	if err := decodeParams(raw, &p, "chat.attach params must include workspaceId, tabId, name and data"); err != nil {
		return nil, err
	}
	key, err := keyFrom(p.WorkspaceID, p.TabID, "chat.attach")
	if err != nil {
		return nil, err
	}
	name, ok := plainName(p.Name)
	if !ok {
		return nil, protocolError("chat.attach name must be a file name")
	}
	if base64.StdEncoding.DecodedLen(len(p.Data)) > maxAttachBytes+3 {
		return nil, requestFailed("%s is larger than %d MiB", name, maxAttachBytes>>20)
	}
	data, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return nil, protocolError("chat.attach data must be base64")
	}
	if len(data) > maxAttachBytes {
		return nil, requestFailed("%s is larger than %d MiB", name, maxAttachBytes>>20)
	}
	dir, err := tabAttachDir(key)
	if err != nil {
		return nil, requestFailed("chat.attach: %v", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, requestFailed("chat.attach: %v", err)
	}
	// Each file gets a folder of its own, so two of one name both stay.
	for n := 1; ; n++ {
		slot := filepath.Join(dir, strconv.Itoa(n))
		err := os.Mkdir(slot, 0o700)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return nil, requestFailed("chat.attach: %v", err)
		}
		path := filepath.Join(slot, name)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			return nil, requestFailed("chat.attach: %v", err)
		}
		return AttachResult{Path: path}, nil
	}
}

// PruneAttachments removes the attached files of a workspace's tabs that
// are no longer open, which closed while the app was away.
func (s *Service) PruneAttachments(_ context.Context, raw json.RawMessage) (any, error) {
	var p PruneAttachParams
	if err := decodeParams(raw, &p, "chat.pruneAttachments params must include workspaceId"); err != nil {
		return nil, err
	}
	workspaceID, ok := plainName(strings.TrimSpace(p.WorkspaceID))
	if !ok {
		return nil, protocolError("chat.pruneAttachments workspaceId is required")
	}
	root, err := attachRoot()
	if err != nil {
		return nil, requestFailed("chat.pruneAttachments: %v", err)
	}
	keep := make(map[string]bool, len(p.KeepTabIDs))
	for _, id := range p.KeepTabIDs {
		keep[strings.TrimSpace(id)] = true
	}
	dir := filepath.Join(root, workspaceID)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return struct{}{}, nil
	}
	if err != nil {
		return nil, requestFailed("chat.pruneAttachments: %v", err)
	}
	for _, entry := range entries {
		if !keep[entry.Name()] {
			_ = os.RemoveAll(filepath.Join(dir, entry.Name()))
		}
	}
	return struct{}{}, nil
}

// removeAttachments forgets a closed tab's attached files.
func removeAttachments(key tabKey) {
	if dir, err := tabAttachDir(key); err == nil {
		_ = os.RemoveAll(dir)
	}
}

func tabAttachDir(key tabKey) (string, error) {
	workspaceID, ok := plainName(key.workspaceID)
	if !ok {
		return "", errors.New("workspaceId is not a plain name")
	}
	tabID, ok := plainName(key.tabID)
	if !ok {
		return "", errors.New("tabId is not a plain name")
	}
	root, err := attachRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, workspaceID, tabID), nil
}

// plainName reports whether name is one path segment: not empty, not "."
// or "..", with no separator or NUL.
func plainName(name string) (string, bool) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return "", false
	}
	return name, true
}
