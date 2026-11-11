package chat

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// stagedDir is where a thread another Codex profile keeps is put for this
// profile's program to fork it: thread/fork finds a thread by its id under
// the program's own sessions folder only, whatever path it is given. The
// date folders there are three deep and this one is one, so a staged copy is
// never taken for one of the profile's own threads (rolloutPath).
const stagedDir = "nexus-staged"

// stagedMaxAge is how long a copy may stay that was never taken away: the
// app quit between staging and forking it.
const stagedMaxAge = time.Hour

// StageThread puts a copy of a Codex thread another profile keeps where the
// tab's profile's program finds it, for thread/fork; with Drop, it takes
// the copy away again once the fork is made. Profiles that share a folder
// need no copy.
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
	dir := filepath.Join(to, "sessions", stagedDir)
	if p.Drop {
		suffix := "-" + p.ThreadID + ".jsonl"
		dropped := dropStaged(dir, func(entry os.DirEntry) bool {
			return strings.HasSuffix(entry.Name(), suffix)
		})
		return StageThreadResult{Found: dropped > 0}, nil
	}
	from := codexHome(p.From)
	source := rolloutPath(from, p.ThreadID)
	if source == "" {
		return StageThreadResult{Found: false}, nil
	}
	if filepath.Clean(from) == filepath.Clean(to) {
		return StageThreadResult{Found: true}, nil
	}
	cutoff := time.Now().Add(-stagedMaxAge)
	dropStaged(dir, func(entry os.DirEntry) bool {
		info, err := entry.Info()
		return err == nil && info.ModTime().Before(cutoff)
	})
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, requestFailed("chat.stageThread: %s", err)
	}
	if err := copyFile(source, filepath.Join(dir, filepath.Base(source))); err != nil {
		return nil, requestFailed("chat.stageThread: %s", err)
	}
	return StageThreadResult{Found: true}, nil
}

// dropStaged takes away the staged copies that match, and the folder once it
// is empty; it tells how many it took.
func dropStaged(dir string, match func(os.DirEntry) bool) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	dropped := 0
	for _, entry := range entries {
		if entry.Type().IsRegular() && match(entry) && os.Remove(filepath.Join(dir, entry.Name())) == nil {
			dropped++
		}
	}
	_ = os.Remove(dir)
	return dropped
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
