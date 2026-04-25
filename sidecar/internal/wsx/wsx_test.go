package wsx

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const testSubprotocol = "nexus.sidecar.v1"

type mockHandler struct {
	onMessage func(context.Context, []byte) error

	mu          sync.Mutex
	messages    [][]byte
	closeCode   int
	closeReason string
	closed      chan struct{}
}

func newMockHandler() *mockHandler {
	return &mockHandler{closed: make(chan struct{})}
}

func (h *mockHandler) OnMessage(ctx context.Context, raw []byte) error {
	h.mu.Lock()
	h.messages = append(h.messages, append([]byte(nil), raw...))
	h.mu.Unlock()

	if h.onMessage != nil {
		return h.onMessage(ctx, raw)
	}
	return nil
}

func (h *mockHandler) OnClose(code int, reason string) {
	h.mu.Lock()
	h.closeCode = code
	h.closeReason = reason
	h.mu.Unlock()

	select {
	case <-h.closed:
	default:
		close(h.closed)
	}
}

func TestServerSendCloseLifecycleAndPayloadRoundTrip(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	addr := freeAddr(t)
	h := newMockHandler()
	srv := New(addr, "secret", testSubprotocol, h)
	h.onMessage = func(ctx context.Context, raw []byte) error {
		return srv.Send(ctx, raw)
	}

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ctx) }()
	waitForServer(t, addr)

	conn, br := dialWS(t, addr, "secret", testSubprotocol)
	defer conn.Close()

	writeFrame(t, conn, 2, []byte("ping"))
	opcode, payload := readFrame(t, br)
	if opcode != 2 || string(payload) != "ping" {
		t.Fatalf("echo frame = opcode %d payload %q, want binary ping", opcode, payload)
	}

	closeErr := make(chan error, 1)
	go func() { closeErr <- srv.Close(StatusNormalClosure, "done") }()
	opcode, payload = readFrame(t, br)
	if opcode != 8 {
		t.Fatalf("close opcode = %d, want 8", opcode)
	}
	if got := int(binary.BigEndian.Uint16(payload[:2])); got != StatusNormalClosure {
		t.Fatalf("close code = %d, want %d", got, StatusNormalClosure)
	}
	writeFrame(t, conn, 8, payload)
	if err := <-closeErr; err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	select {
	case <-h.closed:
	case <-time.After(time.Second):
		t.Fatal("handler close was not called")
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.messages) != 1 || string(h.messages[0]) != "ping" {
		t.Fatalf("handler messages = %q, want [ping]", h.messages)
	}
	if h.closeCode != StatusNormalClosure || h.closeReason != "done" {
		t.Fatalf("handler close = %d %q, want %d done", h.closeCode, h.closeReason, StatusNormalClosure)
	}

	cancel()
	if err := <-errCh; err != nil && err != context.Canceled {
		t.Fatalf("Serve() error = %v", err)
	}
}

func TestAuthMiddleware(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := AuthMiddleware("secret")(next)

	for _, tc := range []struct {
		name  string
		token string
		want  int
	}{
		{name: "match", token: "secret", want: http.StatusOK},
		{name: "mismatch", token: "wrong", want: http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Header.Set(sidecarTokenHeader, tc.token)
			rr := httptest.NewRecorder()

			handler.ServeHTTP(rr, req)

			if rr.Code != tc.want {
				t.Fatalf("status = %d, want %d", rr.Code, tc.want)
			}
		})
	}
}

func TestSubprotocolNegotiation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	addr := freeAddr(t)
	h := newMockHandler()
	srv := New(addr, "secret", testSubprotocol, h)
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ctx) }()
	waitForServer(t, addr)

	conn, _ := dialWS(t, addr, "secret", testSubprotocol)
	conn.Close()

	status, _, _, err := handshake(addr, "secret", "wrong.protocol")
	if err != nil {
		t.Fatalf("failed handshake request: %v", err)
	}
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", status, http.StatusBadRequest)
	}

	cancel()
	if err := <-errCh; err != nil && err != context.Canceled {
		t.Fatalf("Serve() error = %v", err)
	}
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().String()
}

func waitForServer(t *testing.T, addr string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 20*time.Millisecond)
		if err == nil {
			conn.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("server did not listen on %s", addr)
}

func dialWS(t *testing.T, addr, token, subprotocol string) (net.Conn, *bufio.Reader) {
	t.Helper()
	status, conn, br, err := handshake(addr, token, subprotocol)
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d, want %d", status, http.StatusSwitchingProtocols)
	}
	return conn, br
}

func handshake(addr, token, subprotocol string) (int, net.Conn, *bufio.Reader, error) {
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		return 0, nil, nil, err
	}

	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		conn.Close()
		return 0, nil, nil, err
	}
	secKey := base64.StdEncoding.EncodeToString(key)
	req := fmt.Sprintf("GET / HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n%s: %s\r\nSec-WebSocket-Protocol: %s\r\n\r\n", addr, secKey, sidecarTokenHeader, token, subprotocol)
	if _, err := io.WriteString(conn, req); err != nil {
		conn.Close()
		return 0, nil, nil, err
	}

	br := bufio.NewReader(conn)
	statusLine, err := br.ReadString('\n')
	if err != nil {
		conn.Close()
		return 0, nil, nil, err
	}
	var proto string
	var status int
	if _, err := fmt.Sscanf(strings.TrimSpace(statusLine), "%s %d", &proto, &status); err != nil {
		conn.Close()
		return 0, nil, nil, err
	}
	protocol := ""
	accept := ""
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			conn.Close()
			return 0, nil, nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		switch http.CanonicalHeaderKey(strings.TrimSpace(parts[0])) {
		case "Sec-Websocket-Protocol":
			protocol = strings.TrimSpace(parts[1])
		case "Sec-Websocket-Accept":
			accept = strings.TrimSpace(parts[1])
		}
	}
	if status != http.StatusSwitchingProtocols {
		conn.Close()
		return status, nil, nil, nil
	}
	if protocol != subprotocol {
		conn.Close()
		return 0, nil, nil, fmt.Errorf("protocol = %q, want %q", protocol, subprotocol)
	}
	if accept != expectedAccept(secKey) {
		conn.Close()
		return 0, nil, nil, fmt.Errorf("accept = %q, want %q", accept, expectedAccept(secKey))
	}
	return status, conn, br, nil
}

func expectedAccept(key string) string {
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func writeFrame(t *testing.T, w io.Writer, opcode byte, payload []byte) {
	t.Helper()
	if len(payload) > 125 {
		t.Fatalf("test frame payload too large: %d", len(payload))
	}
	frame := []byte{0x80 | opcode, 0x80 | byte(len(payload)), 1, 2, 3, 4}
	for i, b := range payload {
		frame = append(frame, b^frame[2+i%4])
	}
	if _, err := w.Write(frame); err != nil {
		t.Fatal(err)
	}
}

func readFrame(t *testing.T, r *bufio.Reader) (byte, []byte) {
	t.Helper()
	header := make([]byte, 2)
	if _, err := io.ReadFull(r, header); err != nil {
		t.Fatal(err)
	}
	opcode := header[0] & 0x0f
	length := int(header[1] & 0x7f)
	if length == 126 || length == 127 {
		t.Fatalf("unsupported extended frame length marker: %d", length)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		t.Fatal(err)
	}
	return opcode, payload
}
