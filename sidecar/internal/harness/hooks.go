package harness

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"nexus-code/sidecar/internal/contracts"
)

const (
	HookEventType = "harness/hook"

	hookSocketDirMode   os.FileMode = 0o700
	hookSocketFileMode  os.FileMode = 0o600
	hookTokenFileMode   os.FileMode = 0o600
	hookSummaryMaxRunes             = 160
)

var (
	ErrHookTokenMismatch     = errors.New("hook token mismatch")
	ErrHookWorkspaceMismatch = errors.New("hook workspaceId mismatch")
)

type HookEventSink interface {
	HandleHookEvent(ctx context.Context, input HookEventInput) (contracts.TabBadgeEvent, error)
}

type HookListenerConfig struct {
	DataDir     string
	WorkspaceID contracts.WorkspaceID
	Sink        HookEventSink

	// Token is optional and primarily intended for tests. Production listeners
	// generate a fresh token for every startup and publish it in TokenPath.
	Token string
}

type HookListener struct {
	dataDir     string
	workspaceID contracts.WorkspaceID
	sink        HookEventSink
	token       string
	socketPath  string
	tokenPath   string

	mu sync.Mutex
	ln net.Listener

	readyOnce sync.Once
	ready     chan struct{}
	readyErr  error

	closeOnce sync.Once
}

type WireHookEvent struct {
	Type        string                `json:"type"`
	WorkspaceID contracts.WorkspaceID `json:"workspaceId"`
	Event       string                `json:"event"`
	Payload     json.RawMessage       `json:"payload"`
}

type HookClientConfig struct {
	SocketPath  string
	TokenPath   string
	WorkspaceID contracts.WorkspaceID
	Event       string
	Payload     json.RawMessage
}

func NewHookListener(config HookListenerConfig) (*HookListener, error) {
	dataDir := strings.TrimSpace(config.DataDir)
	if dataDir == "" {
		return nil, errors.New("hook listener data dir is required")
	}
	workspaceID := contracts.WorkspaceID(strings.TrimSpace(string(config.WorkspaceID)))
	if workspaceID == "" {
		return nil, errors.New("hook listener workspace id is required")
	}
	if config.Sink == nil {
		return nil, errors.New("hook listener sink is required")
	}

	token := strings.TrimSpace(config.Token)
	if token == "" {
		generated, err := generateHookToken()
		if err != nil {
			return nil, err
		}
		token = generated
	}

	return &HookListener{
		dataDir:     dataDir,
		workspaceID: workspaceID,
		sink:        config.Sink,
		token:       token,
		socketPath:  HookSocketPath(dataDir, workspaceID),
		tokenPath:   HookTokenPath(dataDir, workspaceID),
		ready:       make(chan struct{}),
	}, nil
}

func HookSocketPath(dataDir string, workspaceID contracts.WorkspaceID) string {
	return filepath.Join(dataDir, "sock", string(workspaceID)+".sock")
}

func HookTokenPath(dataDir string, workspaceID contracts.WorkspaceID) string {
	return filepath.Join(dataDir, "sock", string(workspaceID)+".token")
}

func DefaultTokenPathForSocket(socketPath string) string {
	if strings.HasSuffix(socketPath, ".sock") {
		return strings.TrimSuffix(socketPath, ".sock") + ".token"
	}
	return socketPath + ".token"
}

func (l *HookListener) SocketPath() string {
	return l.socketPath
}

func (l *HookListener) TokenPath() string {
	return l.tokenPath
}

func (l *HookListener) Token() string {
	return l.token
}

func (l *HookListener) WaitReady(ctx context.Context) error {
	select {
	case <-l.ready:
		return l.readyErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (l *HookListener) Serve(ctx context.Context) error {
	ln, err := l.start()
	if err != nil {
		l.markReady(err)
		return err
	}
	l.markReady(nil)

	go func() {
		<-ctx.Done()
		_ = l.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}

		go func() {
			defer conn.Close()
			if err := l.handleConn(ctx, conn); err != nil {
				// Hook callers are short-lived one-way clients. Rejection is signaled
				// by closing the Unix socket without forwarding to the sink.
				return
			}
		}()
	}
}

func (l *HookListener) Close() error {
	var err error
	l.closeOnce.Do(func() {
		l.mu.Lock()
		ln := l.ln
		l.mu.Unlock()
		if ln != nil {
			err = ln.Close()
		}
		if removeErr := os.Remove(l.socketPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) && err == nil {
			err = removeErr
		}
	})
	return err
}

func (l *HookListener) start() (net.Listener, error) {
	sockDir := filepath.Dir(l.socketPath)
	if err := os.MkdirAll(sockDir, hookSocketDirMode); err != nil {
		return nil, fmt.Errorf("create hook socket dir: %w", err)
	}
	if err := os.Chmod(sockDir, hookSocketDirMode); err != nil {
		return nil, fmt.Errorf("chmod hook socket dir: %w", err)
	}

	if err := os.Remove(l.socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("remove stale hook socket: %w", err)
	}
	if err := writeTokenFile(l.tokenPath, l.token); err != nil {
		return nil, err
	}

	ln, err := net.Listen("unix", l.socketPath)
	if err != nil {
		return nil, fmt.Errorf("listen hook unix socket: %w", err)
	}
	if err := os.Chmod(l.socketPath, hookSocketFileMode); err != nil {
		_ = ln.Close()
		_ = os.Remove(l.socketPath)
		return nil, fmt.Errorf("chmod hook unix socket: %w", err)
	}

	l.mu.Lock()
	l.ln = ln
	l.mu.Unlock()
	return ln, nil
}

func (l *HookListener) markReady(err error) {
	l.readyOnce.Do(func() {
		l.readyErr = err
		close(l.ready)
	})
}

func (l *HookListener) handleConn(ctx context.Context, conn net.Conn) error {
	reader := bufio.NewReader(conn)
	tokenLine, err := reader.ReadString('\n')
	if err != nil {
		return fmt.Errorf("read hook token line: %w", err)
	}
	gotToken := strings.TrimRight(tokenLine, "\r\n")
	if !constantTimeTokenEqual(gotToken, l.token) {
		return ErrHookTokenMismatch
	}

	eventLine, err := reader.ReadString('\n')
	if err != nil {
		return fmt.Errorf("read hook event line: %w", err)
	}

	event, err := DecodeWireHookEvent([]byte(strings.TrimRight(eventLine, "\r\n")))
	if err != nil {
		return err
	}
	if event.WorkspaceID != l.workspaceID {
		return fmt.Errorf("%w: got %q want %q", ErrHookWorkspaceMismatch, event.WorkspaceID, l.workspaceID)
	}

	input, err := HookEventInputFromWire(event)
	if err != nil {
		return err
	}
	_, err = l.sink.HandleHookEvent(ctx, input)
	return err
}

func SendHookEvent(ctx context.Context, config HookClientConfig) error {
	socketPath := strings.TrimSpace(config.SocketPath)
	if socketPath == "" {
		return errors.New("hook socket path is required")
	}
	workspaceID := contracts.WorkspaceID(strings.TrimSpace(string(config.WorkspaceID)))
	if workspaceID == "" {
		return errors.New("hook workspace id is required")
	}
	eventName := strings.TrimSpace(config.Event)
	if eventName == "" {
		return errors.New("hook event is required")
	}
	payload := bytesTrimSpace(config.Payload)
	if len(payload) == 0 {
		return errors.New("hook payload is required")
	}
	if !json.Valid(payload) {
		return errors.New("hook payload must be valid JSON")
	}

	tokenPath := strings.TrimSpace(config.TokenPath)
	if tokenPath == "" {
		tokenPath = DefaultTokenPathForSocket(socketPath)
	}
	token, err := readTokenFile(tokenPath)
	if err != nil {
		return err
	}

	event, err := EncodeWireHookEvent(WireHookEvent{
		Type:        HookEventType,
		WorkspaceID: workspaceID,
		Event:       eventName,
		Payload:     append(json.RawMessage(nil), payload...),
	})
	if err != nil {
		return err
	}

	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return fmt.Errorf("dial hook unix socket: %w", err)
	}
	defer conn.Close()

	if _, err := io.WriteString(conn, token+"\n"); err != nil {
		return fmt.Errorf("write hook token line: %w", err)
	}
	if _, err := conn.Write(append(event, '\n')); err != nil {
		return fmt.Errorf("write hook event line: %w", err)
	}
	return nil
}

func EncodeWireHookEvent(event WireHookEvent) ([]byte, error) {
	if event.Type == "" {
		event.Type = HookEventType
	}
	if event.Type != HookEventType {
		return nil, fmt.Errorf("unsupported hook wire event type %q", event.Type)
	}
	if event.WorkspaceID == "" {
		return nil, errors.New("hook wire event missing workspaceId")
	}
	if strings.TrimSpace(event.Event) == "" {
		return nil, errors.New("hook wire event missing event")
	}
	payload := bytesTrimSpace(event.Payload)
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	if !json.Valid(payload) {
		return nil, errors.New("hook wire event payload must be valid JSON")
	}
	event.Payload = append(json.RawMessage(nil), payload...)
	return json.Marshal(event)
}

func DecodeWireHookEvent(raw []byte) (WireHookEvent, error) {
	var event WireHookEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		return WireHookEvent{}, fmt.Errorf("decode hook wire event: %w", err)
	}
	if event.Type != HookEventType {
		return WireHookEvent{}, fmt.Errorf("unsupported hook wire event type %q", event.Type)
	}
	if event.WorkspaceID == "" {
		return WireHookEvent{}, errors.New("hook wire event missing workspaceId")
	}
	if strings.TrimSpace(event.Event) == "" {
		return WireHookEvent{}, errors.New("hook wire event missing event")
	}
	if len(bytesTrimSpace(event.Payload)) == 0 || !json.Valid(event.Payload) {
		return WireHookEvent{}, errors.New("hook wire event payload must be valid JSON")
	}
	return event, nil
}

func HookEventInputFromWire(event WireHookEvent) (HookEventInput, error) {
	payload := map[string]any{}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return HookEventInput{}, fmt.Errorf("decode hook payload: %w", err)
	}

	timestamp, err := hookPayloadTimestamp(payload)
	if err != nil {
		return HookEventInput{}, err
	}
	hasError, errorMessage := hookPayloadError(payload)
	eventName := strings.TrimSpace(event.Event)
	if eventName == "" {
		eventName = firstString(payload, "hook_event_name", "hookEventName")
	}

	return HookEventInput{
		EventName:        eventName,
		NotificationType: firstString(payload, "notification_type", "notificationType"),
		SessionID:        firstString(payload, "session_id", "sessionId"),
		AdapterName:      firstString(payload, "adapterName", "adapter_name", "adapter"),
		Timestamp:        timestamp,
		HasError:         hasError,
		ErrorMessage:     errorMessage,
		ToolName:         firstString(payload, "tool_name", "toolName"),
		ToolCallID:       firstString(payload, "tool_use_id", "toolUseId", "tool_id", "toolId", "id"),
		InputSummary:     summarizeHookValue(payload["tool_input"]),
		ResultSummary:    summarizeHookValue(payload["tool_response"]),
		Message:          firstString(payload, "message"),
	}, nil
}

func writeTokenFile(path, token string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, hookTokenFileMode)
	if err != nil {
		return fmt.Errorf("create hook token file: %w", err)
	}
	_, writeErr := io.WriteString(file, token+"\n")
	closeErr := file.Close()
	if writeErr != nil {
		return fmt.Errorf("write hook token file: %w", writeErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close hook token file: %w", closeErr)
	}
	if err := os.Chmod(path, hookTokenFileMode); err != nil {
		return fmt.Errorf("chmod hook token file: %w", err)
	}
	return nil
}

func readTokenFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open hook token file: %w", err)
	}
	defer file.Close()

	line, err := bufio.NewReader(file).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("read hook token file: %w", err)
	}
	token := strings.TrimRight(line, "\r\n")
	if token == "" {
		return "", errors.New("hook token file is empty")
	}
	return token, nil
}

func generateHookToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate hook token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func constantTimeTokenEqual(got, want string) bool {
	gotHash := sha256.Sum256([]byte(got))
	wantHash := sha256.Sum256([]byte(want))
	return subtle.ConstantTimeCompare(gotHash[:], wantHash[:]) == 1 && len(got) == len(want)
}

func firstString(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		value, ok := payload[key]
		if !ok {
			continue
		}
		if s, ok := value.(string); ok {
			if trimmed := strings.TrimSpace(s); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func hookPayloadTimestamp(payload map[string]any) (time.Time, error) {
	timestamp := firstString(payload, "timestamp", "createdAt", "created_at")
	if timestamp == "" {
		return time.Time{}, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse hook payload timestamp: %w", err)
	}
	return parsed, nil
}

func hookPayloadError(payload map[string]any) (bool, string) {
	if value, ok := payload["hasError"].(bool); ok && value {
		return true, firstString(payload, "errorMessage", "error_message")
	}
	errorMessage := firstString(payload, "errorMessage", "error_message")
	if errorMessage != "" {
		return true, errorMessage
	}
	if errValue, ok := payload["error"]; ok {
		switch v := errValue.(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				return true, strings.TrimSpace(v)
			}
		case map[string]any:
			message := firstString(v, "message", "errorMessage", "error_message")
			if message != "" {
				return true, message
			}
			return true, "hook payload error"
		default:
			if errValue != nil {
				return true, "hook payload error"
			}
		}
	}
	return false, ""
}

func summarizeHookValue(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return truncateRunes(strings.TrimSpace(v), hookSummaryMaxRunes)
	case bool, float64, int, int64, uint64:
		return truncateRunes(fmt.Sprint(v), hookSummaryMaxRunes)
	case []any:
		if len(v) == 0 {
			return "[]"
		}
		return fmt.Sprintf("[%d items]", len(v))
	case map[string]any:
		return summarizeHookMap(v)
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return truncateRunes(fmt.Sprint(v), hookSummaryMaxRunes)
		}
		return truncateRunes(string(raw), hookSummaryMaxRunes)
	}
}

func summarizeHookMap(value map[string]any) string {
	if len(value) == 0 {
		return "{}"
	}

	preferredKeys := []string{
		"file_path",
		"path",
		"command",
		"description",
		"pattern",
		"query",
		"url",
		"old_string",
		"new_string",
	}
	seen := map[string]bool{}
	parts := make([]string, 0, 4)
	for _, key := range preferredKeys {
		if raw, ok := value[key]; ok {
			parts = append(parts, fmt.Sprintf("%s: %s", key, summarizeHookScalar(key, raw)))
			seen[key] = true
		}
		if len(parts) >= 4 {
			return truncateRunes(strings.Join(parts, ", "), hookSummaryMaxRunes)
		}
	}

	keys := make([]string, 0, len(value))
	for key := range value {
		if !seen[key] {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s: %s", key, summarizeHookScalar(key, value[key])))
		if len(parts) >= 4 {
			break
		}
	}
	return truncateRunes(strings.Join(parts, ", "), hookSummaryMaxRunes)
}

func summarizeHookScalar(key string, value any) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case string:
		trimmed := strings.TrimSpace(v)
		if isLargeTextKey(key) && trimmed != "" {
			return fmt.Sprintf("<%d chars>", len([]rune(trimmed)))
		}
		return truncateRunes(trimmed, 80)
	case bool, float64, int, int64, uint64:
		return fmt.Sprint(v)
	case []any:
		return fmt.Sprintf("[%d items]", len(v))
	case map[string]any:
		return "{...}"
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return truncateRunes(fmt.Sprint(v), 80)
		}
		return truncateRunes(string(raw), 80)
	}
}

func isLargeTextKey(key string) bool {
	switch normalizedHookName(key) {
	case "content", "text", "prompt", "oldstring", "newstring":
		return true
	default:
		return false
	}
}

func truncateRunes(value string, maxRunes int) string {
	value = strings.TrimSpace(value)
	if value == "" || maxRunes <= 0 {
		return value
	}
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	if maxRunes <= 1 {
		return string(runes[:maxRunes])
	}
	return string(runes[:maxRunes-1]) + "…"
}

func bytesTrimSpace(raw []byte) []byte {
	return []byte(strings.TrimSpace(string(raw)))
}
