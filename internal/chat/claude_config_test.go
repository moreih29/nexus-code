package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func claudeConfigOf(t *testing.T, dir string) ClaudeConfigResult {
	t.Helper()
	params, _ := json.Marshal(ClaudeConfigParams{ConfigDir: dir})
	result, err := New().ClaudeConfig(context.Background(), params)
	if err != nil {
		t.Fatalf("ClaudeConfig: %v", err)
	}
	return result.(ClaudeConfigResult)
}

func TestClaudeConfigReadsOnlyTheSettingsKeys(t *testing.T) {
	dir := t.TempDir()
	body := `{"theme":"light","verbose":true,"respectGitignore":false,` +
		`"oauthAccount":{"emailAddress":"me@example.com"},"primaryApiKey":"sk-secret",` +
		`"projects":{"/repo":{"allowedTools":[]}},"editorMode":{"not":"a scalar"}}`
	if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	got := claudeConfigOf(t, dir)
	if !got.Found {
		t.Fatal("found = false")
	}
	want := map[string]string{"theme": `"light"`, "verbose": "true", "respectGitignore": "false"}
	if len(got.Values) != len(want) {
		t.Fatalf("values = %v, want only %v", got.Values, want)
	}
	for key, value := range want {
		if string(got.Values[key]) != value {
			t.Errorf("%s = %s, want %s", key, got.Values[key], value)
		}
	}
}

func TestClaudeConfigFallsBackToTheLegacyFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".config.json"), []byte(`{"theme":"dark-ansi"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got := claudeConfigOf(t, dir)
	if !got.Found || string(got.Values["theme"]) != `"dark-ansi"` {
		t.Fatalf("got %+v", got)
	}
}
