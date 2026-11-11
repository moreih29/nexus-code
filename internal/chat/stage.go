package chat

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

// stagedDir is where a thread another Codex profile keeps is put for this
// profile's program to fork it: thread/fork finds a thread by its id under
// the program's own sessions folder only, whatever path it is given. The
// date folders there are three deep and this one is one, so a staged copy is
// never taken for one of the profile's own threads (rolloutPath).
//
// A copy stays: the fork keeps only what it adds, and Codex reads the rest
// from the thread it was forked from each time it resumes the fork.
const stagedDir = "nexus-staged"

// stagedLineage is how many threads back a staged thread's forks are
// followed, so a lineage that loops ends.
const stagedLineage = 64

// StageThread puts a copy of a Codex thread another profile keeps where the
// tab's profile's program finds it, for thread/fork, with the threads it was
// forked from that the profile does not keep: Codex reads a fork's history
// from them. Profiles that share a folder need no copy.
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

// forkedFrom is the thread a Codex thread was forked from, as its first
// line (session_meta) names it; "" for none.
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

// keptRollout is the file a profile keeps a thread in, its own or one
// staged there for it; "" when it keeps none.
func keptRollout(home, threadID string) string {
	if path := rolloutPath(home, threadID); path != "" {
		return path
	}
	matches, _ := filepath.Glob(filepath.Join(home, "sessions", stagedDir, "rollout-*-"+threadID+".jsonl"))
	return newestFile(matches)
}

// copyGrown copies a thread over its copy unless the copy is as long: a
// thread only grows, and a fork reads the thread it came from only as far
// as it went when forked, which a longer copy holds too.
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
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// rolloutPath is the file Codex keeps a thread in, "" when none is found:
// <CODEX_HOME>/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<thread id>.jsonl, or
// under archived_sessions once archived.
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

// codexHome resolves a Codex profile's folder on this host: the one given,
// else CODEX_HOME as the login shell or the agent has it, else ~/.codex.
func codexHome(given string) string {
	home, _ := os.UserHomeDir()
	if dir := expandProfileDir(given, home); dir != "" {
		return dir
	}
	return defaultProfileDir("codex", home)
}
