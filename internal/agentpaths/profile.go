package agentpaths

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func ExpandProfileDir(dir, home string) string {
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
		rest := dir[2:]
		if dir[1] == '\\' && runtime.GOOS != "windows" {
			rest = strings.ReplaceAll(rest, `\`, "/")
		}
		dir = filepath.Join(home, rest)
	}
	return filepath.Clean(dir)
}

func ProfileEnvDir(key, value string) string {
	if runtime.GOOS == "windows" {
		key = strings.ToUpper(key)
	}
	if key != "CLAUDE_CONFIG_DIR" && key != "CODEX_HOME" {
		return value
	}
	home, _ := os.UserHomeDir()
	dir := ExpandProfileDir(value, home)
	if dir == "" {
		return ""
	}
	if absolute, err := filepath.Abs(dir); err == nil {
		return absolute
	}
	return dir
}
