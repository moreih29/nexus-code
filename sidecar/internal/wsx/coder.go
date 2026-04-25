package wsx

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/coder/websocket"
)

const sidecarTokenHeader = "X-Sidecar-Token"

type coderServer struct {
	addr        string
	token       string
	subprotocol string
	h           Handler

	connMu sync.Mutex
	conn   *websocket.Conn

	writeMu sync.Mutex
}

func New(addr, token, subprotocol string, h Handler) Server {
	return &coderServer{
		addr:        addr,
		token:       token,
		subprotocol: subprotocol,
		h:           h,
	}
}

func AuthMiddleware(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := r.Header.Get(sidecarTokenHeader)
			if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
				http.Error(w, http.StatusText(http.StatusUnauthorized), http.StatusUnauthorized)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func (s *coderServer) Serve(ctx context.Context) error {
	handler := AuthMiddleware(s.token)(http.HandlerFunc(s.handleUpgrade))
	server := &http.Server{Addr: s.addr, Handler: handler}

	errCh := make(chan error, 1)
	go func() {
		errCh <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		_ = s.Close(StatusGoingAway, "server shutting down")
		err := server.Shutdown(context.Background())
		if err != nil {
			return err
		}
		if serveErr := <-errCh; serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			return serveErr
		}
		return ctx.Err()
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func (s *coderServer) Send(ctx context.Context, msg any) error {
	payload, err := encodePayload(msg)
	if err != nil {
		return err
	}

	s.connMu.Lock()
	conn := s.conn
	s.connMu.Unlock()
	if conn == nil {
		return errors.New("websocket connection is not established")
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return conn.Write(ctx, websocket.MessageBinary, payload)
}

func (s *coderServer) Close(code int, reason string) error {
	s.connMu.Lock()
	conn := s.conn
	s.connMu.Unlock()
	if conn == nil {
		return nil
	}

	if code == StatusAbnormalClosure {
		return conn.CloseNow()
	}
	return conn.Close(websocket.StatusCode(code), reason)
}

func (s *coderServer) handleUpgrade(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != "" {
		http.Error(w, http.StatusText(http.StatusForbidden), http.StatusForbidden)
		return
	}

	if !hasSubprotocol(r, s.subprotocol) {
		http.Error(w, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}

	s.connMu.Lock()
	if s.conn != nil {
		s.connMu.Unlock()
		http.Error(w, http.StatusText(http.StatusConflict), http.StatusConflict)
		return
	}
	s.connMu.Unlock()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{s.subprotocol},
	})
	if err != nil {
		return
	}

	s.connMu.Lock()
	s.conn = conn
	s.connMu.Unlock()

	defer func() {
		s.connMu.Lock()
		if s.conn == conn {
			s.conn = nil
		}
		s.connMu.Unlock()
	}()

	s.readLoop(r.Context(), conn)
}

func (s *coderServer) readLoop(ctx context.Context, conn *websocket.Conn) {
	defer conn.CloseNow()

	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			code, reason := closeDetails(err)
			s.h.OnClose(code, reason)
			return
		}

		if err := s.h.OnMessage(ctx, payload); err != nil {
			_ = conn.Close(websocket.StatusInternalError, err.Error())
			s.h.OnClose(StatusInternalError, err.Error())
			return
		}
	}
}

func encodePayload(msg any) ([]byte, error) {
	switch v := msg.(type) {
	case []byte:
		return v, nil
	case string:
		return []byte(v), nil
	default:
		return json.Marshal(v)
	}
}

func hasSubprotocol(r *http.Request, expected string) bool {
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, protocol := range strings.Split(header, ",") {
			if strings.TrimSpace(protocol) == expected {
				return true
			}
		}
	}
	return false
}

func closeDetails(err error) (int, string) {
	var closeErr websocket.CloseError
	if errors.As(err, &closeErr) {
		return int(closeErr.Code), closeErr.Reason
	}
	return StatusAbnormalClosure, fmt.Sprint(err)
}
