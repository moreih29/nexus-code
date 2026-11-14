package hookserver

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
)

// A tab's processes reach the server with a token of their tab's, not the
// server's: the server's token bound to the workspace and tab ids. A
// process holding one can speak only for the tab it was started in, so an
// agent cannot set NEXUS_TAB_ID to another tab's (a terminal the user
// types in) and be taken for the user, or for the agent manager. Main
// makes the same token for the tabs it starts (tabHookToken in
// src/main/features/workspace/tab-token.ts); hook.getInfo says the server
// takes them ("tabTokens").

// TabToken is the token the tab's processes are started with.
func TabToken(serverToken, workspaceID, tabID string) string {
	mac := hmac.New(sha256.New, []byte(serverToken))
	// The workspace id's length keeps one pair of ids from reading as another.
	fmt.Fprintf(mac, "nexus-tab-token/v1|%d|%s|%s", len(workspaceID), workspaceID, tabID)
	return hex.EncodeToString(mac.Sum(nil))
}

// tokenKind is how a request's token matched: a tab's, made for the ids it
// names; the server's own, which a terminal an older app started still
// has; or neither, refused.
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
