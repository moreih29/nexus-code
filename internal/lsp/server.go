package lsp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type serverProcess struct {
	service *Service

	id            string
	workspaceID   string
	languageID    string
	binaryPath    string
	args          []string
	workspaceRoot string
	idleTimeout   time.Duration

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser

	writeMu sync.Mutex

	mu                              sync.Mutex
	internalSeq                     uint64
	pendingInternal                 map[string]chan rpcResponse
	pendingServerRequests           map[string]json.RawMessage
	pendingWatchedFileRegistrations map[string][]watchedFileRegistration
	watchedFileRegistrations        []watchedFileRegistration
	idleTimer                       *time.Timer
	exited                          bool
	exitErr                         error
	stderrBuf                       []byte

	done         chan struct{}
	exitOnce     sync.Once
	shutdownOnce sync.Once
	shutdownErr  error
}

type rpcResponse struct {
	Raw    json.RawMessage
	Result json.RawMessage
	Error  *jsonRPCError
	Err    error
}

func newServerProcess(service *Service, id string, p SpawnParams, idleTimeout time.Duration) *serverProcess {
	return &serverProcess{
		service:                         service,
		id:                              id,
		workspaceID:                     p.WorkspaceID,
		languageID:                      p.LanguageID,
		binaryPath:                      p.BinaryPath,
		args:                            p.Args,
		workspaceRoot:                   p.WorkspaceRoot,
		idleTimeout:                     idleTimeout,
		pendingInternal:                 make(map[string]chan rpcResponse),
		pendingServerRequests:           make(map[string]json.RawMessage),
		pendingWatchedFileRegistrations: make(map[string][]watchedFileRegistration),
		done:                            make(chan struct{}),
	}
}

func (p *serverProcess) start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	cmd := exec.Command(p.binaryPath, p.args...)
	cmd.Dir = p.workspaceRoot
	cmd.Env = os.Environ()

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return requestFailed("lsp.spawn stdin pipe failed: %s", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return requestFailed("lsp.spawn stdout pipe failed: %s", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return requestFailed("lsp.spawn stderr pipe failed: %s", err)
	}
	if err := cmd.Start(); err != nil {
		return requestFailed("lsp.spawn failed: %s", err)
	}

	p.cmd = cmd
	p.stdin = stdin
	p.stdout = stdout
	p.stderr = stderr

	go p.readLoop()
	go p.captureStderr()
	go p.waitLoop()
	return nil
}

// captureStderr drains the language server's stderr into a bounded ring
// buffer so the last few KB survive even when the server crashes silently.
// The buffer is then flushed onto the serverExited event payload.
func (p *serverProcess) captureStderr() {
	buf := make([]byte, 4*1024)
	for {
		n, err := p.stderr.Read(buf)
		if n > 0 {
			p.appendStderr(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

func (p *serverProcess) appendStderr(chunk []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stderrBuf = append(p.stderrBuf, chunk...)
	if overflow := len(p.stderrBuf) - stderrTailBytes; overflow > 0 {
		p.stderrBuf = append(p.stderrBuf[:0], p.stderrBuf[overflow:]...)
	}
}

func (p *serverProcess) snapshotStderr() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.stderrBuf) == 0 {
		return ""
	}
	return string(p.stderrBuf)
}

func (p *serverProcess) initialize(ctx context.Context) (json.RawMessage, error) {
	result, err := p.request(ctx, "initialize", p.initializeParams())
	if err != nil {
		return nil, err
	}

	capabilities := json.RawMessage(`{}`)
	if len(result) > 0 && string(result) != "null" {
		var parsed struct {
			Capabilities json.RawMessage `json:"capabilities"`
		}
		if err := json.Unmarshal(result, &parsed); err != nil {
			return nil, requestFailed("lsp initialize result was invalid: %s", err)
		}
		if len(parsed.Capabilities) > 0 {
			capabilities = append(json.RawMessage(nil), parsed.Capabilities...)
		}
	}

	if err := p.notify("initialized", map[string]any{}); err != nil {
		return nil, err
	}
	return capabilities, nil
}

func (p *serverProcess) initializeParams() map[string]any {
	rootURI := fileURI(p.workspaceRoot)
	return map[string]any{
		"processId": os.Getpid(),
		"rootPath":  p.workspaceRoot,
		"rootUri":   rootURI,
		"workspaceFolders": []map[string]string{
			{
				"uri":  rootURI,
				"name": p.workspaceID,
			},
		},
		"capabilities": map[string]any{
			"workspace": map[string]any{
				"didChangeWatchedFiles": map[string]any{
					"dynamicRegistration": true,
				},
			},
			"textDocument": map[string]any{
				"documentSymbol": map[string]any{
					"hierarchicalDocumentSymbolSupport": true,
				},
			},
		},
		"clientInfo": map[string]string{
			"name": "nexus-code-agent",
		},
	}
}

func (p *serverProcess) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := p.nextInternalID()
	key := "s:" + id
	response := make(chan rpcResponse, 1)

	p.mu.Lock()
	if p.exited {
		err := p.exitErr
		p.mu.Unlock()
		return nil, requestFailed("lsp server exited: %v", err)
	}
	p.pendingInternal[key] = response
	p.mu.Unlock()

	message := struct {
		JSONRPC string `json:"jsonrpc"`
		ID      string `json:"id"`
		Method  string `json:"method"`
		Params  any    `json:"params,omitempty"`
	}{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	}
	raw, err := json.Marshal(message)
	if err != nil {
		p.deleteInternal(key)
		return nil, err
	}
	if err := p.sendRaw(raw); err != nil {
		p.deleteInternal(key)
		return nil, err
	}

	select {
	case resp := <-response:
		if resp.Err != nil {
			return nil, resp.Err
		}
		if resp.Error != nil {
			message := resp.Error.Message
			if strings.TrimSpace(message) == "" {
				message = fmt.Sprintf("LSP %s failed with code %d", method, resp.Error.Code)
			}
			return nil, requestFailed("LSP %s failed: %s", method, message)
		}
		return resp.Result, nil
	case <-ctx.Done():
		p.deleteInternal(key)
		return nil, ctx.Err()
	case <-p.done:
		return nil, requestFailed("lsp server exited")
	}
}

func (p *serverProcess) notify(method string, params any) error {
	message := struct {
		JSONRPC string `json:"jsonrpc"`
		Method  string `json:"method"`
		Params  any    `json:"params,omitempty"`
	}{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}
	raw, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return p.sendRaw(raw)
}

func (p *serverProcess) cancel(requestID json.RawMessage) error {
	message := struct {
		JSONRPC string `json:"jsonrpc"`
		Method  string `json:"method"`
		Params  struct {
			ID json.RawMessage `json:"id"`
		} `json:"params"`
	}{
		JSONRPC: "2.0",
		Method:  "$/cancelRequest",
	}
	message.Params.ID = append(json.RawMessage(nil), requestID...)
	raw, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return p.sendRaw(raw)
}

func (p *serverProcess) sendRaw(message json.RawMessage) error {
	frame, err := EncodeRawMessage(message)
	if err != nil {
		return protocolError(err.Error())
	}

	p.mu.Lock()
	exited := p.exited
	p.mu.Unlock()
	if exited {
		return requestFailed("lsp server exited")
	}

	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	_, err = p.stdin.Write(frame)
	if err != nil {
		return requestFailed("lsp write failed: %s", err)
	}
	return nil
}
