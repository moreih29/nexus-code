package hookclient

import (
	"encoding/json"
	"io"
	"strings"
)

// sendMessageSubcmd is the PreToolUse hook on Claude's SendMessage tool
// (claude-wrapper.sh). It is decided here, from the call alone: no agent, no
// socket, so it costs the call nothing it waits on.
const sendMessageSubcmd = "send-message"

// bridgePrefix marks a SendMessage target that is a Remote Control session,
// as Claude lists another computer's sessions.
const bridgePrefix = "bridge:"

// sendMessageDenyReason is what Claude is told when its SendMessage to a
// Remote Control session is refused: the nexus CLI carries the message
// instead, under the tab's name and with how to answer it.
const sendMessageDenyReason = "This Claude runs in NexusCode, which reaches a session on another computer " +
	"with the nexus CLI, so the message arrives under its tab's name and says how to answer. " +
	"Find the session with `nexus session list --device all`, then send it with " +
	"`nexus chat send TAB --device DEVICE --workspace WORKSPACE -` (the message on stdin; `nexus terminal send` for a terminal). " +
	"SendMessage to a Remote Control session (bridge:...) is turned off here. " +
	"If the session is not in that list, tell the user instead of sending it another way."

// sendMessageCall is the part of a PreToolUse payload the hook reads.
type sendMessageCall struct {
	ToolName  string `json:"tool_name"`
	ToolInput struct {
		To string `json:"to"`
	} `json:"tool_input"`
}

// preToolUseOutput is the PreToolUse hook's answer as Claude Code reads it.
type preToolUseOutput struct {
	HookSpecificOutput struct {
		HookEventName            string `json:"hookEventName"`
		PermissionDecision       string `json:"permissionDecision"`
		PermissionDecisionReason string `json:"permissionDecisionReason"`
	} `json:"hookSpecificOutput"`
}

// sendMessageDecision is the hook's output for a tool call: a deny, with the
// way to send it instead, for a SendMessage to a Remote Control session; for
// anything else (a teammate, a subagent, a session on this computer, a
// payload it cannot read) nothing, which lets the call go on as it would.
func sendMessageDecision(payload []byte) string {
	var call sendMessageCall
	if json.Unmarshal(payload, &call) != nil {
		return ""
	}
	if call.ToolName != "SendMessage" || !strings.HasPrefix(strings.TrimSpace(call.ToolInput.To), bridgePrefix) {
		return ""
	}
	var out preToolUseOutput
	out.HookSpecificOutput.HookEventName = "PreToolUse"
	out.HookSpecificOutput.PermissionDecision = "deny"
	out.HookSpecificOutput.PermissionDecisionReason = sendMessageDenyReason
	b, err := json.Marshal(out)
	if err != nil {
		return ""
	}
	return string(b)
}

// runSendMessage reads the hook's payload from in and writes its decision to
// out. It always exits 0: a hook that fails leaves the call as it was.
func runSendMessage(in io.Reader, out io.Writer) int {
	payload, err := io.ReadAll(in)
	if err != nil {
		return 0
	}
	if decision := sendMessageDecision(payload); decision != "" {
		_, _ = io.WriteString(out, decision)
	}
	return 0
}
