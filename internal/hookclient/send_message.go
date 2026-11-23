package hookclient

import (
	"encoding/json"
	"io"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const sendMessageSubcmd = "send-message"

const bridgePrefix = "bridge:"

const sendMessageDenyReason = "This Claude runs in NexusCode, which reaches a session on another computer " +
	"with the nexus CLI, so the message arrives under its tab's name and says how to answer. " +
	"Find the session with `nexus session list --device all`, then send it with " +
	"`nexus chat send TAB --device DEVICE --workspace WORKSPACE -` (the message on stdin; `nexus terminal send` for a terminal). " +
	"SendMessage to a Remote Control session (bridge:...) is turned off here. " +
	"If the session is not in that list, tell the user instead of sending it another way."

type sendMessageCall struct {
	ToolName  string `json:"tool_name"`
	ToolInput struct {
		To string `json:"to"`
	} `json:"tool_input"`
}

type preToolUseOutput struct {
	HookSpecificOutput struct {
		HookEventName            string `json:"hookEventName"`
		PermissionDecision       string `json:"permissionDecision"`
		PermissionDecisionReason string `json:"permissionDecisionReason"`
	} `json:"hookSpecificOutput"`
}

func sendMessageDecision(payload []byte) string {
	var call sendMessageCall
	if json.Unmarshal(payload, &call) != nil {
		return ""
	}
	if call.ToolName != "SendMessage" || !strings.HasPrefix(strings.TrimSpace(call.ToolInput.To), bridgePrefix) {
		return ""
	}
	return denySendMessage(sendMessageDenyReason)
}

func denySendMessage(reason string) string {
	var out preToolUseOutput
	out.HookSpecificOutput.HookEventName = "PreToolUse"
	out.HookSpecificOutput.PermissionDecision = "deny"
	out.HookSpecificOutput.PermissionDecisionReason = reason
	b, err := json.Marshal(out)
	if err != nil {
		return ""
	}
	return string(b)
}

func runSendMessage(in io.Reader, out io.Writer) int {
	payload, err := io.ReadAll(io.LimitReader(in, proto.MaxHookRequestBytes+1))
	if len(payload) > proto.MaxHookRequestBytes {
		_, _ = io.Copy(io.Discard, in)
		_, _ = io.WriteString(out, denySendMessage("SendMessage denied: hook input exceeds the 16 MiB limit."))
		return 0
	}
	if err != nil {
		return 0
	}
	if decision := sendMessageDecision(payload); decision != "" {
		_, _ = io.WriteString(out, decision)
	}
	return 0
}
