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

// A tab's program gets the environment the user's login shell sets up, as a
// terminal's claude or codex does. An app started from the Dock or a desktop
// entry, and an agent started over SSH, have less than the user's terminal:
// an API key or a gateway's address exported in .zshrc or .bashrc reaches
// the program only this way. The variables that belong to the shell's own
// session, or that the app sets itself, are left out.

const (
	loginEnvTimeout = 5 * time.Second
	// loginEnvTTL is how long one reading serves: tabs that start together
	// ask the shell once, and a change to the profile reaches the next tab
	// soon after.
	loginEnvTTL = 10 * time.Second
	// The markers set the environment apart from what the startup files
	// print.
	loginEnvStart = "__NEXUS_LOGIN_ENV__"
	loginEnvEnd   = "__NEXUS_LOGIN_ENV_END__"
)

// loginEnv is the login shell's environment, read at most once a
// loginEnvTTL; the tests put their own in its place.
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
	// A shell that failed is not asked again at once either: each tab would
	// wait out its timeout.
	if !c.at.IsZero() && time.Since(c.at) < loginEnvTTL {
		return c.env
	}
	c.env = readLoginEnv()
	c.at = time.Now()
	return c.env
}

// readLoginEnv runs the user's shell as a login, interactive shell, as a
// terminal does, and returns what it exports. It is nil on Windows, which
// has no login shell, and when the shell fails or takes too long.
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
	// -i too: many export their keys in .zshrc or .bashrc.
	cmd := exec.CommandContext(ctx, shell, "-ilc", script)
	// A process the startup files left running can hold the output open.
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return parseLoginEnv(string(out))
}

// parseLoginEnv reads `env -0`'s output between the markers, leaving out
// what is the shell's or the app's.
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

// fromLoginShell reports whether a tab's program takes the login shell's
// value of key. The shell's own session (its folder, depth and terminal)
// is not the program's; the app's marks, the shims it points the shells
// at and Electron's switches are the app's to set; and a parent Claude
// Code session's are left out as from the agent's environment.
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

// mergeEnv overlays the login shell's environment, then
// the tab's variables, on the agent's environment. The app's wrapper
// directory goes first on the PATH, as for terminals, and variables a
// parent Claude Code session sets are left out, so the program starts as
// its own session.
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

// inheritedOnly names the variables of a Claude Code session the agent may
// have been started from, which would make the program take itself for a
// part of that session.
func inheritedOnly(key string) bool {
	switch key {
	case "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT":
		return true
	}
	return false
}

// prependPath puts dir first on env's PATH, unless it is first already.
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
