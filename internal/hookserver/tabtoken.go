package hookserver

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
)

const refusedCLI = "this process's NEXUS_TAB_ID and NEXUS_HOOK_TOKEN are not one tab's: " +
	"run nexus as its terminal or tab started it"

func TabToken(serverToken, workspaceID, tabID string) string {
	mac := hmac.New(sha256.New, []byte(serverToken))
	fmt.Fprintf(mac, "nexus-tab-token/v1|%d|%s|%s", len(workspaceID), workspaceID, tabID)
	return hex.EncodeToString(mac.Sum(nil))
}

type tokenKind int

const (
	tokenRefused tokenKind = iota
	tokenTab
	tokenServer
)

func (s *Server) tokenOf(req hookWireRequest) tokenKind {
	if equal(req.Token, TabToken(s.token, req.WorkspaceID, req.TabID)) {
		return tokenTab
	}
	if equal(req.Token, s.token) {
		return tokenServer
	}
	return tokenRefused
}

func equal(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
