package chat

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

const (
	loginEnvTimeout = 5 * time.Second
	loginEnvTTL     = 10 * time.Second
	loginEnvStart   = "__NEXUS_LOGIN_ENV__"
	loginEnvEnd     = "__NEXUS_LOGIN_ENV_END__"
)

var loginEnv = cachedLoginEnv

var loginEnvCache struct {
	mu  sync.Mutex
	at  time.Time
	env map[string]string
}

func cachedLoginEnv() map[string]string {
	c := &loginEnvCache
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.at.IsZero() && time.Since(c.at) < loginEnvTTL {
		return c.env
	}
	c.env = readLoginEnv()
	c.at = time.Now()
	return c.env
}

func readLoginEnv() map[string]string {
	if runtime.GOOS == "windows" {
		return nil
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), loginEnvTimeout)
	defer cancel()
	script := "printf '%s' '" + loginEnvStart + "'; command env -0; printf '%s' '" + loginEnvEnd + "'"
	cmd := exec.CommandContext(ctx, shell, "-ilc", script)
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return parseLoginEnv(string(out))
}

func parseLoginEnv(out string) map[string]string {
	_, rest, found := strings.Cut(out, loginEnvStart)
	if !found {
		return nil
	}
	end := strings.LastIndex(rest, loginEnvEnd)
	if end < 0 {
		return nil
	}
	env := make(map[string]string)
	for _, entry := range strings.Split(rest[:end], "\x00") {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" || !fromLoginShell(key) {
			continue
		}
		env[key] = value
	}
	return env
}

func fromLoginShell(key string) bool {
	switch key {
	case "PWD", "OLDPWD", "SHLVL", "_",
		"TERM", "COLORTERM", "COLUMNS", "LINES", "TMUX", "TMUX_PANE",
		"ZDOTDIR", "BASH_ENV", "ENV":
		return false
	}
	for _, prefix := range []string{"TERM_", "NEXUS_", "ELECTRON_"} {
		if strings.HasPrefix(key, prefix) {
			return false
		}
	}
	return !inheritedOnly(key)
}

func mergeEnv(overrides map[string]string) []string {
	merged := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || inheritedOnly(key) {
			continue
		}
		merged[key] = agentpaths.ProfileEnvDir(key, value)
	}
	for key, value := range loginEnv() {
		merged[key] = agentpaths.ProfileEnvDir(key, value)
	}
	for key, value := range overrides {
		for existing := range merged {
			if sameEnvKey(existing, key) {
				delete(merged, existing)
			}
		}
		merged[key] = agentpaths.ProfileEnvDir(key, value)
	}
	if dir := overrides[wrapperDirEnv]; dir != "" {
		prependPath(merged, dir)
	}
	if !hasLocale(merged) {
		merged["LANG"] = "C.UTF-8"
	}
	keys := make([]string, 0, len(merged))
	for key := range merged {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	env := make([]string, 0, len(keys))
	for _, key := range keys {
		env = append(env, key+"="+merged[key])
	}
	return env
}

const wrapperDirEnv = "NEXUS_WRAPPER_SELF_DIR"

func inheritedOnly(key string) bool {
	switch key {
	case "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT":
		return true
	}
	return false
}

func prependPath(env map[string]string, dir string) {
	sep := string(os.PathListSeparator)
	for key, value := range env {
		if sameEnvKey(key, "PATH") {
			if value == dir || strings.HasPrefix(value, dir+sep) {
				return
			}
			if value != "" {
				dir += sep + value
			}
			env[key] = dir
			return
		}
	}
	env["PATH"] = dir
}

func hasLocale(env map[string]string) bool {
	for _, key := range []string{"LANG", "LC_ALL", "LC_CTYPE"} {
		if env[key] != "" {
			return true
		}
	}
	return false
}
