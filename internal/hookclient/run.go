package hookclient

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"time"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	envAgentSocket      = "NEXUS_AGENT_SOCKET"
	envHookToken        = "NEXUS_HOOK_TOKEN"
	envWorkspaceID      = "NEXUS_WORKSPACE_ID"
	envTabID            = "NEXUS_TAB_ID"
	envClaudePrint      = "NEXUS_CLAUDE_PRINT"
	envClaudeEntrypoint = "CLAUDE_CODE_ENTRYPOINT"

	permissionRequestSubcmd = "permission-request"

	permissionTimeout = time.Hour + 10*time.Second

	defaultTimeout = 15 * time.Second
)

type hookRequest struct {
	Type          string          `json:"type"`
	Token         string          `json:"token"`
	WorkspaceID   string          `json:"workspaceId"`
	TabID         string          `json:"tabId"`
	Subcommand    string          `json:"subcommand"`
	Payload       json.RawMessage `json:"payload"`
	AssistantText string          `json:"assistantText,omitempty"`
	AgentMessages []agentMessage  `json:"agentMessages,omitempty"`
	Print         bool            `json:"print,omitempty"`
}

const stopSubcmd = "stop"

type stopPayload struct {
	TranscriptPath       string  `json:"transcript_path"`
	TranscriptPathCamel  string  `json:"transcriptPath"`
	LastAssistantMessage *string `json:"last_assistant_message"`
}

type hookResponse struct {
	OK       bool   `json:"ok"`
	Stdout   string `json:"stdout,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
}

func Run(args []string) int {
	subcommand := ""
	if len(args) > 0 {
		subcommand = args[0]
	}

	if subcommand == sendMessageSubcmd {
		return runSendMessage(os.Stdin, os.Stdout)
	}

	socketPath := os.Getenv(envAgentSocket)
	token := os.Getenv(envHookToken)
	workspaceID := os.Getenv(envWorkspaceID)
	tabID := os.Getenv(envTabID)

	if socketPath == "" || token == "" || workspaceID == "" || tabID == "" {
		drainStdin()
		return 0
	}

	payload, err := readStdinPayload(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "nexus hook: stdin read failed: %v\n", err)
		return 0
	}

	timeout := chooseTimeout(subcommand)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	return runWithContext(ctx, socketPath, token, workspaceID, tabID, subcommand, payload)
}

func runWithContext(
	ctx context.Context,
	socketPath, token, workspaceID, tabID, subcommand string,
	payload json.RawMessage,
) int {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "nexus hook: connect failed: %v\n", err)
		return 0
	}
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			fmt.Fprintf(os.Stderr, "nexus hook: set deadline failed: %v\n", err)
		}
	}

	assistantText := ""
	if subcommand == stopSubcmd {
		assistantText = stopAssistantText(payload)
	}

	req := hookRequest{
		Type:          "hook",
		Token:         token,
		WorkspaceID:   workspaceID,
		TabID:         tabID,
		Subcommand:    subcommand,
		Payload:       payload,
		AssistantText: assistantText,
		AgentMessages: hookAgentMessages(subcommand, payload),
		Print:         os.Getenv(envClaudePrint) == "1" || os.Getenv(envClaudeEntrypoint) == "sdk-cli",
	}
	if err := writeNDJSON(conn, req); err != nil {
		fmt.Fprintf(os.Stderr, "nexus hook: send failed: %v\n", err)
		return 0
	}

	resp, err := readNDJSON(conn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "nexus hook: recv failed: %v\n", err)
		return 1
	}

	return handleResponse(resp)
}

func handleResponse(resp hookResponse) int {
	if !resp.OK {
		fmt.Fprintf(os.Stderr, "nexus hook: agent error: %s\n", resp.Error)
		return 1
	}

	if resp.Stdout != "" {
		if _, err := io.WriteString(os.Stdout, resp.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "nexus hook: stdout write failed: %v\n", err)
			return 1
		}
	}

	if resp.ExitCode != nil {
		return *resp.ExitCode
	}
	return 0
}

func chooseTimeout(subcommand string) time.Duration {
	if subcommand == permissionRequestSubcmd {
		return permissionTimeout
	}
	return defaultTimeout
}

func writeNDJSON(w io.Writer, v any) error {
	bw := bufio.NewWriter(w)
	enc := json.NewEncoder(bw)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return err
	}
	return bw.Flush()
}

func readNDJSON(r io.Reader) (hookResponse, error) {
	scanner := bufio.NewScanner(r)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return hookResponse{}, err
		}
		return hookResponse{}, fmt.Errorf("connection closed without response")
	}
	var resp hookResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		return hookResponse{}, fmt.Errorf("invalid response JSON: %w", err)
	}
	return resp, nil
}

func readStdinPayload(in io.Reader) (json.RawMessage, error) {
	data, err := io.ReadAll(io.LimitReader(in, proto.MaxHookRequestBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > proto.MaxHookRequestBytes {
		if _, err := io.Copy(io.Discard, in); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("payload exceeds the %d-byte hook request limit", proto.MaxHookRequestBytes)
	}
	if len(data) == 0 {
		return json.RawMessage("{}"), nil
	}
	return json.RawMessage(data), nil
}

func drainStdin() {
	_, _ = io.Copy(io.Discard, os.Stdin)
}

func stopAssistantText(payload json.RawMessage) string {
	var p stopPayload
	if len(payload) > 0 && json.Unmarshal(payload, &p) == nil && p.LastAssistantMessage != nil {
		return truncateChars(normalizeSingleLine(*p.LastAssistantMessage), transcriptPreviewMaxChars)
	}
	if path := transcriptPathFromPayload(payload); path != "" {
		return extractLastAssistantText(path)
	}
	return ""
}

func transcriptPathFromPayload(payload json.RawMessage) string {
	if len(payload) == 0 {
		return ""
	}
	var p stopPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return ""
	}
	if p.TranscriptPath != "" {
		return p.TranscriptPath
	}
	return p.TranscriptPathCamel
}
