// Package hookclient는 Go agent 바이너리가 `agent hook <subcommand>` 로
// 호출될 때 실행되는 경량 entrypoint를 제공한다.
//
// Claude Code는 hook 이벤트 발생 시 이 바이너리를 subprocess로 spawn하고,
// stdin으로 JSON payload를 전달한다. 이 패키지는:
//  1. ENV에서 연결 정보를 읽어 agent의 Unix 도메인 소켓에 접속한다.
//  2. hook 이벤트를 NDJSON 한 줄로 송신한다.
//  3. 응답 한 줄을 대기해 stdout write 및 종료코드 결정을 처리한다.
//
// PTY/FS/Git/LSP 서비스를 일절 init하지 않으므로 시작 지연이 없다.
// 연결 실패 등 어떤 경우라도 Claude Code를 죽이지 않는 silent fallback을 우선한다.
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
)

// 환경 변수 키 상수 — hook 클라이언트가 읽는 연결 정보 집합.
const (
	envAgentSocket  = "NEXUS_AGENT_SOCKET"
	envHookToken    = "NEXUS_HOOK_TOKEN"
	envWorkspaceID  = "NEXUS_WORKSPACE_ID"
	envTabID        = "NEXUS_TAB_ID"

	// permissionRequestSubcmd 는 긴 blocking timeout이 필요한 서브커맨드 이름.
	permissionRequestSubcmd = "permission-request"

	// permissionTimeout 은 permission-request 서브커맨드에 적용하는 최대 대기 시간.
	permissionTimeout = 130 * time.Second

	// defaultTimeout 은 그 외 모든 서브커맨드에 적용하는 기본 대기 시간.
	defaultTimeout = 15 * time.Second
)

// hookRequest 는 agent의 hookserver로 전송하는 NDJSON 요청 프레임이다.
// 필드명은 shared/claude/status.ts의 HookRequestSchema와 일치한다.
type hookRequest struct {
	Type        string          `json:"type"`
	Token       string          `json:"token"`
	WorkspaceID string          `json:"workspaceId"`
	TabID       string          `json:"tabId"`
	Subcommand  string          `json:"subcommand"`
	Payload     json.RawMessage `json:"payload"`
}

// hookResponse 는 agent로부터 받는 NDJSON 응답 프레임이다.
// 필드명은 shared/claude/status.ts의 HookResponseSchema와 일치한다.
type hookResponse struct {
	OK       bool   `json:"ok"`
	Stdout   string `json:"stdout,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
}

// Run 은 `agent hook <subcommand> [args...]` 엔트리포인트다.
//
// args[0]이 서브커맨드명이며, Claude Code는 나머지 인자를 전달하지 않는다.
// ENV 미설정 · 소켓 없음 · 연결 실패 등 모든 오류는 silent fallback(exit 0)으로
// 처리해 Claude Code 프로세스를 죽이지 않는다.
func Run(args []string) int {
	// 서브커맨드 추출 — 없으면 빈 문자열로 진행해 agent가 분류하도록 위임한다.
	subcommand := ""
	if len(args) > 0 {
		subcommand = args[0]
	}

	// ENV에서 연결 정보 읽기.
	socketPath := os.Getenv(envAgentSocket)
	token := os.Getenv(envHookToken)
	workspaceID := os.Getenv(envWorkspaceID)
	tabID := os.Getenv(envTabID)

	// 4개 중 하나라도 비어 있으면 stdin을 drain한 뒤 즉시 exit 0한다.
	// hook이 설치되지 않은 환경과 동일한 효과를 내며 Claude를 죽이지 않는다.
	if socketPath == "" || token == "" || workspaceID == "" || tabID == "" {
		drainStdin()
		return 0
	}

	// stdin에서 Claude Code가 전달한 hook 이벤트 JSON payload를 읽는다.
	payload, err := readStdinPayload()
	if err != nil {
		// payload 읽기 실패는 경고만 출력하고 silent fallback한다.
		fmt.Fprintf(os.Stderr, "nexus hook: stdin read failed: %v\n", err)
		return 0
	}

	// 서브커맨드에 따라 timeout을 결정한다.
	timeout := chooseTimeout(subcommand)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	return runWithContext(ctx, socketPath, token, workspaceID, tabID, subcommand, payload)
}

// runWithContext 는 실제 소켓 통신 및 응답 처리를 수행한다.
// context timeout이 dial+write+read 전체에 적용된다.
func runWithContext(
	ctx context.Context,
	socketPath, token, workspaceID, tabID, subcommand string,
	payload json.RawMessage,
) int {
	// Unix 도메인 소켓에 dial한다.
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socketPath)
	if err != nil {
		// 소켓 없음·연결 거부는 silent fallback — Claude를 죽이지 않는다.
		fmt.Fprintf(os.Stderr, "nexus hook: connect failed: %v\n", err)
		return 0
	}
	defer conn.Close()

	// context deadline을 소켓 I/O deadline으로도 설정한다.
	if deadline, ok := ctx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			fmt.Fprintf(os.Stderr, "nexus hook: set deadline failed: %v\n", err)
		}
	}

	// NDJSON 요청 한 줄을 송신한다.
	req := hookRequest{
		Type:        "hook",
		Token:       token,
		WorkspaceID: workspaceID,
		TabID:       tabID,
		Subcommand:  subcommand,
		Payload:     payload,
	}
	if err := writeNDJSON(conn, req); err != nil {
		fmt.Fprintf(os.Stderr, "nexus hook: send failed: %v\n", err)
		return 0
	}

	// 응답 한 줄을 대기한다.
	resp, err := readNDJSON(conn)
	if err != nil {
		// timeout 포함 — stderr 경고 후 exit 1로 Claude Code에 실패를 전달한다.
		fmt.Fprintf(os.Stderr, "nexus hook: recv failed: %v\n", err)
		return 1
	}

	return handleResponse(resp)
}

// handleResponse 는 hook 응답 프레임을 해석해 종료코드를 결정한다.
func handleResponse(resp hookResponse) int {
	if !resp.OK {
		fmt.Fprintf(os.Stderr, "nexus hook: agent error: %s\n", resp.Error)
		return 1
	}

	// stdout이 있으면 그대로 쓴다 — Claude Code가 hook 응답으로 읽는다.
	if resp.Stdout != "" {
		if _, err := io.WriteString(os.Stdout, resp.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "nexus hook: stdout write failed: %v\n", err)
			return 1
		}
	}

	// exitCode가 명시된 경우 그 값을 사용하고, 미명시면 0으로 처리한다.
	if resp.ExitCode != nil {
		return *resp.ExitCode
	}
	return 0
}

// chooseTimeout 은 서브커맨드 이름을 보고 적절한 timeout을 반환한다.
// permission-request 는 사용자 결정 대기 시간이 길어 별도 긴 timeout을 사용한다.
func chooseTimeout(subcommand string) time.Duration {
	if subcommand == permissionRequestSubcmd {
		return permissionTimeout
	}
	return defaultTimeout
}

// writeNDJSON 은 v를 JSON으로 직렬화해 개행 문자와 함께 w에 쓴다.
func writeNDJSON(w io.Writer, v any) error {
	bw := bufio.NewWriter(w)
	enc := json.NewEncoder(bw)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return err
	}
	return bw.Flush()
}

// readNDJSON 은 r에서 개행으로 구분된 NDJSON 한 줄을 읽어 hookResponse로 파싱한다.
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

// readStdinPayload 는 stdin 전체를 읽어 JSON RawMessage로 반환한다.
// 읽은 내용이 유효한 JSON이 아니어도 그대로 전달해 agent에서 판단하도록 한다.
func readStdinPayload() (json.RawMessage, error) {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		// 빈 stdin은 빈 JSON object로 대체한다.
		return json.RawMessage("{}"), nil
	}
	return json.RawMessage(data), nil
}

// drainStdin 은 stdin을 모두 읽어 버린다.
// Claude Code가 파이프 상대방이 읽지 않은 채 닫힐 때 SIGPIPE를 받지 않도록 한다.
func drainStdin() {
	_, _ = io.Copy(io.Discard, os.Stdin)
}
