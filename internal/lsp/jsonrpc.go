package lsp

import (
	"encoding/json"
	"net/url"
	"path/filepath"
	"strings"
)

func stringField(raw json.RawMessage) (string, bool) {
	var value string
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || value == "" {
		return "", false
	}
	return value, true
}

func jsonRPCIDKey(raw json.RawMessage) (string, bool) {
	// JSON-RPC 2.0 forbids a null id on requests, and treating it as a
	// valid key would let any server-sent null collide with the literal
	// "null" string id we never use ourselves. Reject it outright.
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return "s:" + s, true
	}
	var n json.Number
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.UseNumber()
	if err := decoder.Decode(&n); err == nil {
		return "n:" + n.String(), true
	}
	return "", false
}

func fileURI(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(abs)}
	return u.String()
}
