package chat

// Agent profiles: a Claude or Codex config folder of its own (CLAUDE_CONFIG_DIR,
// CODEX_HOME), with its own sign-in. Before a tab runs with one, the app has
// the folder made here, on the host the program runs on: Codex will not start
// with a CODEX_HOME that does not exist, and a "~/" folder means this host's
// home. What the user shares between profiles (instructions, settings,
// skills) is linked from the default folder.

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ProfileDirParams is the wire shape for chat.profileDir.
type ProfileDirParams struct {
	// Agent is "claude" or "codex": whose default folder links point to.
	Agent string `json:"agent"`
	// Dir is the profile's folder; "~/" is this host's home.
	Dir string `json:"dir"`
	// Shared names what the folder links from the default folder.
	Shared []string `json:"shared,omitempty"`
	// Shareable names everything it may link: a link of one no longer
	// shared is removed.
	Shareable []string `json:"shareable,omitempty"`
}

// ProfileDirResult is returned by chat.profileDir.
type ProfileDirResult struct {
	// Dir is the folder's absolute path, for the program's variable.
	Dir string `json:"dir"`
	// DefaultDir is the agent's default folder, which the links point to.
	DefaultDir string `json:"defaultDir"`
	// Linked names the shared entries the folder links (made now or before).
	Linked []string `json:"linked"`
	// Failed names the shared entries that could not be linked.
	Failed []string `json:"failed"`
}

// ProfileDir makes a profile's folder and its links.
func (s *Service) ProfileDir(_ context.Context, raw json.RawMessage) (any, error) {
	var p ProfileDirParams
	if err := decodeParams(raw, &p, "chat.profileDir params must include dir"); err != nil {
		return nil, err
	}
	if p.Agent != "claude" && p.Agent != "codex" {
		return nil, protocolError("chat.profileDir agent must be claude or codex")
	}
	home, _ := os.UserHomeDir()
	dir := expandProfileDir(p.Dir, home)
	if dir == "" || !filepath.IsAbs(dir) {
		return nil, protocolError("chat.profileDir dir must be absolute or start with ~/")
	}
	defaultDir := defaultProfileDir(p.Agent, home)
	if defaultDir != "" && sameDir(dir, defaultDir) {
		return nil, requestFailed("chat.profileDir: %s is the default folder", dir)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, requestFailed("chat.profileDir: %s", err)
	}
	result := ProfileDirResult{Dir: dir, DefaultDir: defaultDir, Linked: []string{}, Failed: []string{}}
	shared := make(map[string]bool, len(p.Shared))
	for _, name := range p.Shared {
		if validShareName(name) {
			shared[name] = true
		}
	}
	names := append([]string{}, p.Shareable...)
	for _, name := range p.Shared {
		if !contains(names, name) {
			names = append(names, name)
		}
	}
	for _, name := range names {
		if !validShareName(name) || defaultDir == "" {
			continue
		}
		target := filepath.Join(defaultDir, name)
		link := filepath.Join(dir, name)
		if !shared[name] {
			unlinkShared(link, target)
			continue
		}
		switch linkShared(link, target) {
		case linkMade:
			result.Linked = append(result.Linked, name)
		case linkFailed:
			result.Failed = append(result.Failed, name)
		}
	}
	return result, nil
}

// expandProfileDir resolves "~" and "~/…" against home and cleans the path.
func expandProfileDir(dir, home string) string {
	dir = strings.TrimSpace(dir)
	switch {
	case dir == "":
		return ""
	case dir == "~":
		dir = home
	case strings.HasPrefix(dir, "~/") || strings.HasPrefix(dir, `~\`):
		if home == "" {
			return ""
		}
		dir = filepath.Join(home, dir[2:])
	}
	return filepath.Clean(dir)
}

// defaultProfileDir is the folder the agent uses with its variable unset, or
// set by the user's login shell.
func defaultProfileDir(agent, home string) string {
	key, name := "CLAUDE_CONFIG_DIR", ".claude"
	if agent == "codex" {
		key, name = "CODEX_HOME", ".codex"
	}
	if value := strings.TrimSpace(loginEnv()[key]); value != "" {
		return expandProfileDir(value, home)
	}
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return expandProfileDir(value, home)
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, name)
}

func sameDir(a, b string) bool {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// validShareName is one entry of the folder, not a path out of it.
func validShareName(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, `/\`)
}

func contains(list []string, value string) bool {
	for _, v := range list {
		if v == value {
			return true
		}
	}
	return false
}

type linkOutcome int

const (
	linkSkipped linkOutcome = iota // nothing to link, or the folder has its own
	linkMade                       // linked, now or before
	linkFailed
)

// linkShared links the default folder's entry into the profile's folder,
// unless the folder has one of its own: a file the user put there wins.
func linkShared(link, target string) linkOutcome {
	if info, err := os.Lstat(link); err == nil {
		if info.Mode()&fs.ModeSymlink != 0 {
			if got, err := os.Readlink(link); err == nil && sameDir(got, target) {
				return linkMade
			}
		}
		return linkSkipped
	} else if !errors.Is(err, fs.ErrNotExist) {
		return linkFailed
	}
	if _, err := os.Stat(target); err != nil {
		return linkSkipped
	}
	if err := os.Symlink(target, link); err != nil {
		return linkFailed
	}
	return linkMade
}

// unlinkShared removes a link to the default folder's entry: no longer shared.
func unlinkShared(link, target string) {
	info, err := os.Lstat(link)
	if err != nil || info.Mode()&fs.ModeSymlink == 0 {
		return
	}
	if got, err := os.Readlink(link); err == nil && sameDir(got, target) {
		_ = os.Remove(link)
	}
}
