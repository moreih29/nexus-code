package chat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// claudeConfigKeys are the settings Claude Code's /config keeps in its
// global config file (~/.claude.json) rather than in settings.json, or
// falls back to it for. Only these are read out: the file also holds the
// account and every project's state.
var claudeConfigKeys = map[string]bool{
	"agentPushNotifEnabled":      true,
	"autoCompactEnabled":         true,
	"autoConnectIde":             true,
	"autoScrollEnabled":          true,
	"copyFullResponse":           true,
	"copyOnSelect":               true,
	"defaultToAgentsView":        true,
	"editorMode":                 true,
	"externalEditorContext":      true,
	"fileCheckpointingEnabled":   true,
	"inputNeededNotifEnabled":    true,
	"leftArrowOpensAgents":       true,
	"preferredNotifChannel":      true,
	"promptSuggestionEnabled":    true,
	"prStatusFooterEnabled":      true,
	"remoteControlAtStartup":     true,
	"respectGitignore":           true,
	"showTurnDuration":           true,
	"teammateMode":               true,
	"terminalProgressBarEnabled": true,
	"theme":                      true,
	"verbose":                    true,
	"workflowSizeGuideline":      true,
}

// claudeConfigCapBytes bounds the file read: it grows with every project.
const claudeConfigCapBytes = 64 << 20

// ClaudeConfig returns the settings above as Claude Code's global config
// file has them, for the Claude tab's settings dialog: get_settings tells
// only what settings.json has.
func (s *Service) ClaudeConfig(_ context.Context, raw json.RawMessage) (any, error) {
	var p ClaudeConfigParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}
	values := map[string]json.RawMessage{}
	path := claudeConfigPath(p.ConfigDir)
	if path == "" {
		return ClaudeConfigResult{Found: false, Values: values}, nil
	}
	file, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return ClaudeConfigResult{Found: false, Values: values}, nil
	}
	if err != nil {
		return nil, requestFailed("chat.claudeConfig: %s", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, claudeConfigCapBytes+1))
	if err != nil {
		return nil, requestFailed("chat.claudeConfig: %s", err)
	}
	if len(data) > claudeConfigCapBytes {
		return ClaudeConfigResult{Found: false, Values: values}, nil
	}
	var all map[string]json.RawMessage
	if json.Unmarshal(data, &all) != nil {
		return ClaudeConfigResult{Found: false, Values: values}, nil
	}
	for key, value := range all {
		if claudeConfigKeys[key] && isScalar(value) {
			values[key] = value
		}
	}
	return ClaudeConfigResult{Found: true, Values: values}, nil
}

// claudeConfigPath is where Claude Code keeps its global config: in
// CLAUDE_CONFIG_DIR when that is set, else in the home, as .claude.json;
// an install from before that kept it as .config.json in its config
// directory.
func claudeConfigPath(given string) string {
	given = strings.TrimSpace(given)
	if given == "" {
		given = os.Getenv("CLAUDE_CONFIG_DIR")
	}
	var path string
	if given != "" {
		path = filepath.Join(configDir(given), ".claude.json")
	} else if home, _ := os.UserHomeDir(); home != "" {
		path = filepath.Join(home, ".claude.json")
	}
	if path != "" {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	if dir := configDir(given); dir != "" {
		legacy := filepath.Join(dir, ".config.json")
		if info, err := os.Stat(legacy); err == nil && info.Mode().IsRegular() {
			return legacy
		}
	}
	return path
}

// isScalar is whether a JSON value is a string, a number or a boolean.
func isScalar(value json.RawMessage) bool {
	var v any
	if json.Unmarshal(value, &v) != nil {
		return false
	}
	switch v.(type) {
	case string, float64, bool:
		return true
	}
	return false
}
