package hookclient

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func payloadOf(tool, to string) []byte {
	b, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       tool,
		"tool_input":      map[string]any{"to": to, "message": "hello"},
	})
	return b
}

func TestSendMessageDecision_DeniesRemoteControlTargets(t *testing.T) {
	out := sendMessageDecision(payloadOf("SendMessage", "bridge:session_01RJPbBaUztcQGemAGY97DA1"))
	var got preToolUseOutput
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("output %q is not JSON: %v", out, err)
	}
	h := got.HookSpecificOutput
	if h.HookEventName != "PreToolUse" || h.PermissionDecision != "deny" {
		t.Fatalf("got %+v, want a PreToolUse deny", h)
	}
	for _, want := range []string{"nexus session list --device all", "nexus chat send TAB --device DEVICE --workspace WORKSPACE -"} {
		if !strings.Contains(h.PermissionDecisionReason, want) {
			t.Errorf("reason %q does not say %q", h.PermissionDecisionReason, want)
		}
	}
}

func TestSendMessageDecision_LetsEverythingElseGo(t *testing.T) {
	for name, payload := range map[string][]byte{
		"teammate":            payloadOf("SendMessage", "researcher"),
		"main":                payloadOf("SendMessage", "main"),
		"session here":        payloadOf("SendMessage", "NexusCode-Win-P [64b002]"),
		"bridge in the name":  payloadOf("SendMessage", "my bridge:thing"),
		"another tool":        payloadOf("Bash", "bridge:session_x"),
		"not JSON":            []byte("not json"),
		"empty":               nil,
		"structured message":  []byte(`{"tool_name":"SendMessage","tool_input":{"to":"team-lead","message":{"type":"shutdown_response"}}}`),
		"to that is not text": []byte(`{"tool_name":"SendMessage","tool_input":{"to":["bridge:x"]}}`),
	} {
		if out := sendMessageDecision(payload); out != "" {
			t.Errorf("%s: got %q, want nothing", name, out)
		}
	}
}

func TestRunSendMessage_WritesTheDecisionAndExitsZero(t *testing.T) {
	var out bytes.Buffer
	if code := runSendMessage(bytes.NewReader(payloadOf("SendMessage", " bridge:session_1")), &out); code != 0 {
		t.Fatalf("exit %d, want 0", code)
	}
	if !strings.Contains(out.String(), `"permissionDecision":"deny"`) {
		t.Fatalf("got %q, want a deny", out.String())
	}
	out.Reset()
	if code := runSendMessage(bytes.NewReader(payloadOf("SendMessage", "main")), &out); code != 0 || out.Len() != 0 {
		t.Fatalf("got exit %d and %q, want 0 and nothing", code, out.String())
	}
}

func TestRunSendMessageDeniesOversizedInput(t *testing.T) {
	input := strings.NewReader(string(payloadOf("SendMessage", "teammate")) + strings.Repeat(" ", 16<<20))
	var out bytes.Buffer
	if code := runSendMessage(input, &out); code != 0 {
		t.Fatalf("hook exited %d", code)
	}
	var decision preToolUseOutput
	if err := json.Unmarshal(out.Bytes(), &decision); err != nil {
		t.Fatalf("expected a denial, got %q", out.String())
	}
	if got := decision.HookSpecificOutput; got.PermissionDecision != "deny" || !strings.Contains(got.PermissionDecisionReason, "16 MiB") {
		t.Fatalf("unexpected permission decision %+v", got)
	}
	if input.Len() != 0 {
		t.Fatal("hook left input unread")
	}
}
