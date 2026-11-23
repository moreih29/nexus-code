package chat

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

const stagedDir = "nexus-staged"

const stagedLineage = 64

var stagedPublishMu sync.Mutex

func (s *Service) StageThread(_ context.Context, raw json.RawMessage) (any, error) {
	var p StageThreadParams
	if err := decodeParams(raw, &p, "chat.stageThread params must include threadId"); err != nil {
		return nil, err
	}
	if !sessionIDPattern.MatchString(p.ThreadID) {
		return nil, protocolError("chat.stageThread threadId is not a thread id")
	}
	to := codexHome(p.To)
	if to == "" {
		return StageThreadResult{Found: false}, nil
	}
	from := codexHome(p.From)
	source := rolloutPath(from, p.ThreadID)
	if source == "" {
		return StageThreadResult{Found: false}, nil
	}
	if filepath.Clean(from) == filepath.Clean(to) {
		return StageThreadResult{Found: true}, nil
	}
	dir := filepath.Join(to, "sessions", stagedDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, requestFailed("chat.stageThread: %s", err)
	}
	seen := map[string]bool{p.ThreadID: true}
	for path := source; path != ""; {
		if err := copyGrown(path, filepath.Join(dir, filepath.Base(path))); err != nil {
			return nil, requestFailed("chat.stageThread: %s", err)
		}
		parent := forkedFrom(path)
		if parent == "" || seen[parent] || len(seen) >= stagedLineage || rolloutPath(to, parent) != "" {
			break
		}
		seen[parent] = true
		path = keptRollout(from, parent)
	}
	return StageThreadResult{Found: true}, nil
}

func forkedFrom(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	var line struct {
		Type    string `json:"type"`
		Payload struct {
			ForkedFromID string `json:"forked_from_id"`
		} `json:"payload"`
	}
	if json.NewDecoder(file).Decode(&line) != nil || line.Type != "session_meta" {
		return ""
	}
	if id := line.Payload.ForkedFromID; sessionIDPattern.MatchString(id) {
		return id
	}
	return ""
}

func keptRollout(home, threadID string) string {
	if path := rolloutPath(home, threadID); path != "" {
		return path
	}
	matches, _ := filepath.Glob(filepath.Join(home, "sessions", stagedDir, "rollout-*-"+threadID+".jsonl"))
	return newestFile(matches)
}

func copyGrown(from, to string) error {
	source, err := os.Stat(from)
	if err != nil {
		return err
	}
	if copied, err := os.Stat(to); err == nil && copied.Size() >= source.Size() {
		return nil
	}
	return copyFile(from, to)
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.CreateTemp(filepath.Dir(to), ".nexus-rollout-*")
	if err != nil {
		return err
	}
	defer os.Remove(out.Name())
	defer out.Close()
	n, err := io.Copy(out, in)
	if err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}

	stagedPublishMu.Lock()
	defer stagedPublishMu.Unlock()
	if copied, err := os.Stat(to); err == nil && copied.Size() >= n {
		return nil
	}
	return os.Rename(out.Name(), to)
}

func rolloutPath(home, threadID string) string {
	if home == "" {
		return ""
	}
	name := "rollout-*-" + threadID + ".jsonl"
	matches, _ := filepath.Glob(filepath.Join(home, "sessions", "*", "*", "*", name))
	if len(matches) == 0 {
		matches, _ = filepath.Glob(filepath.Join(home, "archived_sessions", name))
	}
	return newestFile(matches)
}

func codexHome(given string) string {
	home, _ := os.UserHomeDir()
	if dir := agentpaths.ProfileEnvDir("CODEX_HOME", given); dir != "" {
		return dir
	}
	return defaultProfileDir("codex", home)
}
