package chat

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/filelink"
)

type ProfileDirParams struct {
	Agent     string   `json:"agent"`
	Dir       string   `json:"dir"`
	Shared    []string `json:"shared,omitempty"`
	Shareable []string `json:"shareable,omitempty"`
}

type ProfileDirResult struct {
	Dir        string   `json:"dir"`
	DefaultDir string   `json:"defaultDir"`
	Linked     []string `json:"linked"`
	Failed     []string `json:"failed"`
}

func (s *Service) ProfileDir(_ context.Context, raw json.RawMessage) (any, error) {
	var p ProfileDirParams
	if err := decodeParams(raw, &p, "chat.profileDir params must include dir"); err != nil {
		return nil, err
	}
	if p.Agent != "claude" && p.Agent != "codex" {
		return nil, protocolError("chat.profileDir agent must be claude or codex")
	}
	home, _ := os.UserHomeDir()
	dir := agentpaths.ExpandProfileDir(p.Dir, home)
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

func defaultProfileDir(agent, home string) string {
	key, name := "CLAUDE_CONFIG_DIR", ".claude"
	if agent == "codex" {
		key, name = "CODEX_HOME", ".codex"
	}
	if value := defaultProfileEnv(key); value != "" {
		return agentpaths.ProfileEnvDir(key, value)
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, name)
}

func defaultProfileEnv(key string) string {
	if value := strings.TrimSpace(loginEnv()[key]); value != "" {
		return value
	}
	return strings.TrimSpace(os.Getenv(key))
}

func sameDir(a, b string) bool {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

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
	linkSkipped linkOutcome = iota
	linkMade
	linkFailed
)

func linkShared(link, target string) linkOutcome {
	if _, err := os.Lstat(link); err == nil {
		if linksTo(link, target) {
			return linkMade
		}
		return linkSkipped
	} else if !errors.Is(err, fs.ErrNotExist) {
		return linkFailed
	}
	info, err := os.Stat(target)
	if err != nil {
		return linkSkipped
	}
	if err := makeLink(link, target, info.IsDir()); err != nil {
		return linkFailed
	}
	return linkMade
}

func unlinkShared(link, target string) {
	if _, err := os.Lstat(link); err == nil && linksTo(link, target) {
		_ = os.Remove(link)
	}
}

func makeLink(link, target string, dir bool) error {
	if runtime.GOOS != "windows" {
		return os.Symlink(target, link)
	}
	if dir {
		return filelink.Junction(link, target)
	}
	if err := os.Symlink(target, link); err == nil {
		return nil
	}
	return os.Link(target, link)
}

func linksTo(link, target string) bool {
	if got, err := os.Readlink(link); err == nil {
		if !filepath.IsAbs(got) {
			got = filepath.Join(filepath.Dir(link), got)
		}
		return sameDir(got, target)
	}
	if runtime.GOOS != "windows" {
		return false
	}
	own, err := os.Lstat(link)
	if err != nil || !own.Mode().IsRegular() {
		return false
	}
	shared, err := os.Stat(target)
	return err == nil && os.SameFile(own, shared)
}
