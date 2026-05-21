// Package hookserver는 agent 프로세스가 Claude Code hook 클라이언트로부터
// NDJSON 프레임을 수신하는 Unix 도메인 소켓 서버를 구현한다.
//
// Claude Code는 hook 이벤트마다 `agent hook <subcommand>` 프로세스를 spawn하고
// stdin으로 payload JSON을 쓴다. 그 프로세스(hookclient)는 이 서버에 연결해
// 요청 프레임을 송신한 뒤 응답 한 줄을 대기한다.
//
// 서버의 역할:
//  1. 요청 검증(토큰 일치) 후 hookId를 발급해 in-flight 맵에 등록한다.
//  2. EventSink를 통해 "claude.hook" 이벤트를 main으로 push한다.
//  3. main이 "claude.respondHook" dispatch 메서드를 호출하면 Respond()가
//     해당 in-flight conn에 응답을 write하고 연결을 닫는다.
//  4. 120초 deadline 내 응답이 없으면 exit 0 응답(응답 생략 동등)을 write하고
//     연결을 닫는다. Claude Code는 응답이 없는 exit 0을 native fallback으로 처리한다.
//
// macOS socket path 104자 제한 대응:
// socketPath = filepath.Join(agentpaths.SocketsDir(), "h-" + shortHash(agentKey) + ".sock")
// agentKey = rootPath + pid. shortHash = sha256[:12] hex = 12자.
// "h-" + 12 + ".sock" = 19자. ~/.nexus-code/sockets/ 기준 최대 ~50자 + 19자 ≤ 104자를 보장한다.
package hookserver

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

// connDeadline 은 hook 클라이언트 연결 1개에 허용하는 최대 응답 대기 시간이다.
// 이 시간이 초과되면 서버는 exit 0 응답(native fallback 동등)을 write하고 연결을 닫는다.
// Claude Code PermissionRequest의 실제 timeout(600s)보다 짧아야 한다.
const connDeadline = 120 * time.Second

// maxSocketPathLen 은 macOS에서 허용하는 Unix 소켓 경로 최대 길이다.
const maxSocketPathLen = 104

// EventSink 는 hook 이벤트를 main으로 push하는 콜백 타입이다.
type EventSink func(name string, payload any) error

// HookEventPayload 는 EventSink에 "claude.hook" 이벤트로 전달하는 페이로드다.
// 필드명은 src/shared/claude/status.ts의 HookRequestSchema와 일치한다.
type HookEventPayload struct {
	HookID      string          `json:"hookId"`
	WorkspaceID string          `json:"workspaceId"`
	TabID       string          `json:"tabId"`
	Subcommand  string          `json:"subcommand"`
	Payload     json.RawMessage `json:"payload"`
}

// HookResponse 는 main이 Respond()를 통해 hook 클라이언트에게 전달하는 응답이다.
// 필드명은 src/shared/claude/status.ts의 HookResponseSchema와 일치한다.
type HookResponse struct {
	Stdout   string `json:"stdout,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
}

// hookWireRequest 는 hookclient가 송신하는 NDJSON 요청 프레임이다.
type hookWireRequest struct {
	Type        string          `json:"type"`
	Token       string          `json:"token"`
	WorkspaceID string          `json:"workspaceId"`
	TabID       string          `json:"tabId"`
	Subcommand  string          `json:"subcommand"`
	Payload     json.RawMessage `json:"payload"`
}

// hookWireResponse 는 hook 클라이언트에게 돌려보내는 NDJSON 응답 프레임이다.
type hookWireResponse struct {
	OK       bool   `json:"ok"`
	Stdout   string `json:"stdout,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
}

// Server 는 hook 클라이언트 연결을 수락하고 in-flight 연결 맵을 관리한다.
type Server struct {
	socketPath string
	token      string
	listener   net.Listener

	sinkMu sync.Mutex
	sink   EventSink

	// inflight 는 hookId → net.Conn 맵이다. sync.Map으로 lock-free 동시 접근을 허용한다.
	inflight sync.Map

	closeOnce sync.Once
	done      chan struct{} // Close() 호출 시 닫혀 accept loop를 깨운다

	// readyCh 는 net.Listener가 성공적으로 생성된 직후 한 번 닫힌다.
	// WaitReady(ctx)가 이 채널로 대기하므로 pull 기반 hook.getInfo RPC가
	// 준비 여부를 race 없이 확인할 수 있다.
	readyCh   chan struct{}
	readyOnce sync.Once

	// testDeadlineNs 가 0이 아니면 connDeadline() 대신 이 값(나노초)을 사용한다.
	// atomic 읽기/쓰기로 race-free하게 접근한다. 테스트 전용.
	testDeadlineNs atomic.Int64
}

// New 는 Unix 도메인 소켓을 listen하고 Server를 반환한다.
//
// agentKey 는 소켓 경로를 결정하는 임의 식별자(예: rootPath + pid)다.
// 0600 퍼미션으로 생성한 후 accept loop goroutine을 시작한다.
// socketPath가 macOS 104자 제한을 초과하면 에러를 반환한다.
func New(agentKey string, sink EventSink) (*Server, error) {
	// 1. 소켓 경로 결정
	socketPath, socketsDir, err := makeSocketPath(agentKey)
	if err != nil {
		return nil, fmt.Errorf("hookserver: %w", err)
	}

	// 2. path 길이 가드
	if len(socketPath) > maxSocketPathLen {
		return nil, fmt.Errorf("hookserver: socket path too long (%d > %d, under ~/.nexus-code/sockets/): %s",
			len(socketPath), maxSocketPathLen, socketPath)
	}

	token, err := newToken()
	if err != nil {
		return nil, fmt.Errorf("hookserver: token generation failed: %w", err)
	}

	// 3. 소켓 디렉토리 보장
	if err := agentpaths.EnsureDir(socketsDir); err != nil {
		return nil, fmt.Errorf("hookserver: %w", err)
	}

	// 4. stale 소켓 청소 (자기 소켓 등록 전)
	cleanStaleSockets(socketsDir, filepath.Base(socketPath))

	// 5. 이전 소켓 파일이 남아 있으면 제거한다.
	_ = os.Remove(socketPath)

	// 6. listen
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("hookserver: listen failed: %w", err)
	}

	// 7. 소켓 파일을 소유자만 접근 가능하도록 0600으로 설정한다.
	if err := os.Chmod(socketPath, 0600); err != nil {
		_ = ln.Close()
		_ = os.Remove(socketPath)
		return nil, fmt.Errorf("hookserver: chmod failed: %w", err)
	}

	s := &Server{
		socketPath: socketPath,
		token:      token,
		listener:   ln,
		sink:       sink,
		done:       make(chan struct{}),
		readyCh:    make(chan struct{}),
	}

	// net.Listener 생성 직후 readyCh를 닫아 WaitReady 대기자를 깨운다.
	s.readyOnce.Do(func() { close(s.readyCh) })

	go s.acceptLoop()
	return s, nil
}

// SocketPath 는 listen 중인 Unix 소켓 경로를 반환한다.
func (s *Server) SocketPath() string { return s.socketPath }

// Token 은 hook 클라이언트 인증에 사용하는 nonce 토큰을 반환한다.
func (s *Server) Token() string { return s.token }

// WaitReady 는 서버가 accept 가능한 상태가 될 때까지 ctx가 취소되기 전까지 대기한다.
// New()가 성공하면 즉시 반환한다 — readyCh는 net.Listener 생성 직후에 닫힌다.
// ctx 취소나 deadline 초과 시 ctx.Err()를 반환한다.
func (s *Server) WaitReady(ctx context.Context) error {
	select {
	case <-s.readyCh:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// SetEventSink 는 hook 이벤트를 push할 sink 콜백을 설정한다.
// host 생성 후 와이어링하는 기존 패턴(fs/git/pty의 SetEventSink)을 따른다.
func (s *Server) SetEventSink(sink EventSink) {
	s.sinkMu.Lock()
	defer s.sinkMu.Unlock()
	s.sink = sink
}

// Respond 는 hookId에 해당하는 in-flight 연결에 응답을 write하고 연결을 닫는다.
// hookId가 없거나 이미 닫힌 경우 에러를 반환한다.
func (s *Server) Respond(hookID string, response HookResponse) error {
	val, ok := s.inflight.LoadAndDelete(hookID)
	if !ok {
		return fmt.Errorf("hookserver: hookId %q not found in inflight map", hookID)
	}
	conn := val.(net.Conn)
	resp := hookWireResponse{
		OK:       true,
		Stdout:   response.Stdout,
		ExitCode: response.ExitCode,
	}
	err := writeNDJSON(conn, resp)
	conn.Close()
	return err
}

// Close 는 listener를 닫고 모든 in-flight 연결에 default 응답을 write한 뒤
// 소켓 파일을 삭제한다. 멱등적으로 동작한다.
func (s *Server) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		close(s.done)

		// listener를 먼저 닫아 acceptLoop가 빠져나오도록 한다.
		closeErr = s.listener.Close()

		// 아직 살아 있는 in-flight 연결에 응답 생략 동등(exit 0) 응답을 보내고 닫는다.
		s.inflight.Range(func(key, val any) bool {
			s.inflight.Delete(key)
			conn := val.(net.Conn)
			_ = writeNDJSON(conn, hookWireResponse{OK: true})
			conn.Close()
			return true
		})

		_ = os.Remove(s.socketPath)
	})
	return closeErr
}

// acceptLoop 는 연결을 계속 수락하며 각 연결을 별도 goroutine에서 처리한다.
func (s *Server) acceptLoop() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			// done이 닫혔으면 정상 종료다.
			select {
			case <-s.done:
			default:
				// done이 아직 열려 있다면 예상치 못한 에러다 — 그냥 반환한다.
			}
			return
		}
		go s.handleConn(conn)
	}
}

// handleConn 은 hook 클라이언트 연결 1개를 처리한다.
// 요청 1줄을 읽고 검증한 뒤 in-flight 맵에 등록하고 EventSink를 호출한다.
// 120초 deadline 내에 Respond()가 호출되지 않으면 exit 0 응답으로 연결을 닫는다.
func (s *Server) handleConn(conn net.Conn) {
	// 120초 deadline을 소켓 read에 적용한다.
	_ = conn.SetDeadline(time.Now().Add(s.connDeadline()))

	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		conn.Close()
		return
	}

	var req hookWireRequest
	if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
		conn.Close()
		return
	}

	// 토큰 불일치는 즉시 연결을 끊는다.
	if req.Token != s.token {
		conn.Close()
		return
	}

	// hookId 발급 후 in-flight 맵에 등록한다.
	hookID, err := newHookID()
	if err != nil {
		_ = writeNDJSON(conn, hookWireResponse{OK: false, Error: "hookId generation failed"})
		conn.Close()
		return
	}
	s.inflight.Store(hookID, conn)

	// read deadline을 해제하고 응답 대기 상태로 전환한다.
	// 이후 Respond()에서 conn.Close()가 호출될 때까지 연결이 살아 있어야 한다.
	_ = conn.SetDeadline(time.Time{})

	// EventSink에 claude.hook 이벤트를 push한다.
	s.sinkMu.Lock()
	sink := s.sink
	s.sinkMu.Unlock()

	payload := HookEventPayload{
		HookID:      hookID,
		WorkspaceID: req.WorkspaceID,
		TabID:       req.TabID,
		Subcommand:  req.Subcommand,
		Payload:     req.Payload,
	}
	if sink != nil {
		if err := sink("claude.hook", payload); err != nil {
			// sink 오류는 경고만 출력하고 deadline timer로 자연 처리되도록 한다.
			fmt.Fprintf(os.Stderr, "hookserver: sink error for hookId %s: %v\n", hookID, err)
		}
	}

	// deadline goroutine: connDeadline 이내에 Respond()가 없으면 default 응답을 보낸다.
	// Respond()가 먼저 호출되면 inflight.LoadAndDelete가 entry를 제거하므로
	// 이 goroutine은 아무것도 하지 않고 종료된다.
	deadline := s.connDeadline()
	go func() {
		timer := time.NewTimer(deadline)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-s.done:
		}
		// LoadAndDelete가 entry를 찾으면 Respond()가 아직 호출되지 않은 것이다.
		val, deleted := s.inflight.LoadAndDelete(hookID)
		if deleted {
			c := val.(net.Conn)
			// exit 0 응답 생략 동등 — Claude Code가 native fallback으로 처리한다.
			_ = writeNDJSON(c, hookWireResponse{OK: true})
			c.Close()
		}
	}()
}

// connDeadline 은 연결당 응답 대기 시간을 반환한다.
// testDeadlineNs가 0이 아닌 경우(테스트 전용) 그 값을 우선한다.
func (s *Server) connDeadline() time.Duration {
	if ns := s.testDeadlineNs.Load(); ns > 0 {
		return time.Duration(ns)
	}
	return connDeadline
}

// makeSocketPath 는 agentKey를 sha256 해싱해 ~/.nexus-code/sockets/ 아래 소켓 경로를 생성한다.
// macOS 104자 제한을 회피하기 위해 해시 앞 12자만 사용한다.
// 반환값: (socketPath, socketsDir, error)
func makeSocketPath(agentKey string) (string, string, error) {
	socketsDir, err := agentpaths.SocketsDir()
	if err != nil {
		return "", "", err
	}
	h := sha256.Sum256([]byte(agentKey))
	short := hex.EncodeToString(h[:])[:12]
	socketPath := filepath.Join(socketsDir, "h-"+short+".sock")
	return socketPath, socketsDir, nil
}

// cleanStaleSockets 는 socketsDir 내 h-*.sock 파일 중 stale 상태인 파일을 제거한다.
// self(selfBasename)는 항상 보존한다.
// stale 기준: mtime이 60초 이상 경과 AND Unix 소켓에 연결 불가(ECONNREFUSED 또는 500ms 내 연결 실패).
// 불확실한 경우(에러가 명확하지 않을 때)는 파일을 보존한다.
func cleanStaleSockets(socketsDir, selfBasename string) {
	entries, err := os.ReadDir(socketsDir)
	if err != nil {
		return
	}

	now := time.Now()
	for _, entry := range entries {
		name := entry.Name()

		// h-*.sock 패턴만 처리한다.
		matched, err := filepath.Match("h-*.sock", name)
		if err != nil || !matched {
			continue
		}

		// self는 항상 보존한다.
		if name == selfBasename {
			continue
		}

		fullPath := filepath.Join(socketsDir, name)

		// mtime이 60초 미만이면 보존한다 (fresh).
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) < 60*time.Second {
			continue
		}

		// 500ms 이내에 Unix 소켓 연결을 시도해 살아있는지 확인한다.
		conn, err := net.DialTimeout("unix", fullPath, 500*time.Millisecond)
		if err == nil {
			// 연결 성공 — 살아있는 소켓이므로 보존한다.
			conn.Close()
			continue
		}

		// 연결 실패 에러를 분류한다.
		// ECONNREFUSED이면 dead socket이므로 제거한다.
		// 다른 에러(permission denied, 경로 오류, timeout 등)는 불확실하므로 보존한다.
		var sysErr syscall.Errno
		if !errors.As(err, &sysErr) || sysErr != syscall.ECONNREFUSED {
			// ECONNREFUSED가 아닌 에러 — 불확실, 보존한다.
			continue
		}

		// dead + old → 제거한다.
		_ = os.Remove(fullPath)
	}
}

// AgentKey 는 rootPath와 pid로 hookserver 소켓 경로의 고유 키를 만든다.
// agent 프로세스가 재시작되면 pid가 바뀌어 자동으로 새 소켓 경로를 얻는다.
func AgentKey(rootPath string) string {
	return rootPath + "\x00" + strconv.Itoa(os.Getpid())
}

// newToken 은 crypto/rand 기반 32 hex 문자 nonce 토큰을 생성한다.
func newToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// newHookID 는 crypto/rand 기반 16자 hex hookId를 생성한다.
func newHookID() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// writeNDJSON 은 v를 JSON으로 직렬화해 개행 문자와 함께 conn에 쓴다.
func writeNDJSON(w interface{ Write([]byte) (int, error) }, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = w.Write(data)
	return err
}
