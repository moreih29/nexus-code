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
)

// Files attached to a Claude or Codex tab's message are sent to the agent
// when the program cannot read them where they are: any file but a small
// image on an SSH or WSL host, one with no path on the user's machine (a
// pasted one), one another device sent. The agent keeps each under
// ~/.nexus-code/attach/<workspaceId>/<tabId>/<n>/<name>, a slot of its
// own, and the message names that path. The conversation may go on in
// another tab, after /resume or from the history, or in a fork, which name
// the same paths: so the files stay when the tab closes, and go as the app
// says (attach_retain.go): when their conversation or workspace is
// deleted, or once unused for a while.

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

// windowsNames is whether a file's name is made one Windows can keep
// (windowsName) before it is written; tests turn it on elsewhere.
var windowsNames = runtime.GOOS == "windows"

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

// AttachRootResult is returned by chat.attachRoot: the folder attached
// files are kept in, absolute.
type AttachRootResult struct {
	Root string `json:"root"`
}

// PruneAttachParams is the wire shape for chat.pruneAttachments.
type PruneAttachParams struct {
	WorkspaceID string `json:"workspaceId"`
	// KeepTabIDs are the workspace's Claude and Codex tabs still open.
	KeepTabIDs []string `json:"keepTabIds"`
	// Retain, when given, keeps what is in use and removes only what has
	// not been for a while (pruneRetained); without it every closed tab's
	// folder goes, as an agent from before it does with any.
	Retain *RetainParams `json:"retain,omitempty"`
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
	// A folder a slot's name can name (slotDir): any other would never go.
	if !slotTab.MatchString(key.tabID) {
		return nil, protocolError("chat.attach tabId is not a tab's id")
	}
	name, ok := plainName(p.Name)
	if !ok {
		return nil, protocolError("chat.attach name must be a file name")
	}
	if windowsNames {
		// The path the message names is the file as written, under this name.
		name = windowsName(name)
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
			// No empty folder, nor half a file, left behind.
			_ = os.RemoveAll(slot)
			return nil, requestFailed("chat.attach: %v", err)
		}
		return AttachResult{Path: path}, nil
	}
}

// AttachRoot tells where attached files are kept (attachRoot): the app
// lets another device read a message's attachments only from below it,
// and the agent alone knows its own NEXUS_CODE_HOME and home folder.
func (s *Service) AttachRoot(_ context.Context, _ json.RawMessage) (any, error) {
	root, err := attachRoot()
	if err != nil {
		return nil, requestFailed("chat.attachRoot: %v", err)
	}
	return AttachRootResult{Root: root}, nil
}

// PruneAttachments removes the attached files a workspace no longer needs:
// with retain, those unused for a while or past its room (pruneRetained);
// without, those of every tab no longer open.
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
	if p.Retain != nil {
		if len(p.Retain.Keep) > maxAttachSlots {
			return nil, protocolError("chat.pruneAttachments keeps too many slots")
		}
		return PruneResult{Removed: pruneRetained(dir, keep, *p.Retain, time.Now())}, nil
	}
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

// windowsReserved matches the names Windows keeps for devices, with any
// extension: "NUL" or "con.txt" is no file there (older Windows), or no
// file at all ("NUL" writes to nowhere).
var windowsReserved = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\.|$)`)

// windowsName is a plain name (plainName) as Windows can keep it: the
// characters it refuses in a name (<>:"/\|?* and control characters) are
// "_", as a colon would otherwise put the bytes in a stream of another
// file; its trailing dots and spaces, which Windows drops, go; a device's
// name gets a "_" in front. A leading dot stays (".env"); never empty.
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

// plainName reports whether name is one path segment: not empty, not "."
// or "..", with no separator or NUL.
func plainName(name string) (string, bool) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return "", false
	}
	return name, true
}
