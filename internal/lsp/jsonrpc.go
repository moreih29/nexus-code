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
	if vol := filepath.VolumeName(abs); len(vol) == 2 && vol[1] == ':' {
		// A Windows drive path. Without a leading slash the drive would land
		// in the host slot (file://C:/x). Use the form VS Code and the
		// renderer send: file:///c%3A/x.
		rest := (&url.URL{Path: filepath.ToSlash(abs[2:])}).EscapedPath()
		return "file:///" + strings.ToLower(vol[:1]) + "%3A" + rest
	}
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(abs)}
	return u.String()
}
