package proto

import (
	"bytes"
	"encoding/json"
	"strings"
)

func DecodeParams(raw json.RawMessage, target any, message string) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || json.Unmarshal(trimmed, target) != nil {
		return ProtocolError(message)
	}
	return nil
}

type TabKey struct {
	WorkspaceID string
	TabID       string
}

func TabKeyFrom(workspaceID, tabID, method string) (TabKey, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	tabID = strings.TrimSpace(tabID)
	if workspaceID == "" {
		return TabKey{}, ProtocolError(method + " workspaceId is required")
	}
	if tabID == "" {
		return TabKey{}, ProtocolError(method + " tabId is required")
	}
	return TabKey{WorkspaceID: workspaceID, TabID: tabID}, nil
}
