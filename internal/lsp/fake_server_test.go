package lsp

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"testing"
)

func TestFakeLSPServerHelper(t *testing.T) {
	if os.Getenv("NEXUS_LSP_FAKE_SERVER") != "1" {
		return
	}
	mode := "roundtrip"
	for i, arg := range os.Args {
		if arg == "--" && i+1 < len(os.Args) {
			mode = os.Args[i+1]
			break
		}
	}
	if err := runFakeLSPServer(mode, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(0)
}

type fakeTransport struct {
	in      io.Reader
	out     io.Writer
	decoder *Decoder
	queue   []json.RawMessage
}

func newFakeTransport(in io.Reader, out io.Writer) *fakeTransport {
	return &fakeTransport{in: in, out: out, decoder: NewDecoder()}
}

func (t *fakeTransport) read() (json.RawMessage, error) {
	for len(t.queue) == 0 {
		buf := make([]byte, 4096)
		n, err := t.in.Read(buf)
		if n > 0 {
			messages, decodeErr := t.decoder.Append(buf[:n])
			t.queue = append(t.queue, messages...)
			if decodeErr != nil {
				return nil, decodeErr
			}
		}
		if err != nil && len(t.queue) == 0 {
			return nil, err
		}
	}
	message := t.queue[0]
	t.queue = t.queue[1:]
	return message, nil
}

func (t *fakeTransport) write(message any) error {
	frame, err := EncodeMessage(message)
	if err != nil {
		return err
	}
	_, err = t.out.Write(frame)
	return err
}

func runFakeLSPServer(mode string, in io.Reader, out io.Writer) error {
	transport := newFakeTransport(in, out)
	recordPath := os.Getenv("NEXUS_LSP_FAKE_RECORD_PATH")
	serverRequestsSent := false

	for {
		message, err := transport.read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(message, &obj); err != nil {
			return err
		}
		method, _ := stringField(obj["method"])
		id := obj["id"]

		switch {
		case method == "initialize" && len(id) > 0:
			if err := transport.write(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(id),
				"result": map[string]any{
					"capabilities": map[string]any{"hoverProvider": true},
				},
			}); err != nil {
				return err
			}
		case method == "initialized":
			if !serverRequestsSent && (mode == "server-request" || mode == "server-request-many") {
				count := 1
				if mode == "server-request-many" {
					count = 25
				}
				for i := 0; i < count; i++ {
					if err := transport.write(map[string]any{
						"jsonrpc": "2.0",
						"id":      json.Number(strconv.Itoa(99 + i)),
						"method":  "workspace/configuration",
						"params": map[string]any{
							"items": []map[string]string{{"section": "fake"}},
						},
					}); err != nil {
						return err
					}
				}
				serverRequestsSent = true
			}
			if !serverRequestsSent && mode == "watched-files" {
				if err := transport.write(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.Number("200"),
					"method":  "client/registerCapability",
					"params": map[string]any{
						"registrations": []map[string]any{
							{
								"id":     "watch-go-files",
								"method": "workspace/didChangeWatchedFiles",
								"registerOptions": map[string]any{
									"watchers": []map[string]any{
										{"globPattern": "**/*.go"},
									},
								},
							},
						},
					},
				}); err != nil {
					return err
				}
				serverRequestsSent = true
			}
		case method == "workspace/didChangeWatchedFiles":
			appendRecord(recordPath, string(message))
		case method == "custom/echo" && len(id) > 0:
			if err := transport.write(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(id),
				"result":  json.RawMessage(obj["params"]),
			}); err != nil {
				return err
			}
		case method == "shutdown" && len(id) > 0:
			appendRecord(recordPath, "shutdown")
			if err := transport.write(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(id),
				"result":  nil,
			}); err != nil {
				return err
			}
		case method == "exit":
			appendRecord(recordPath, "exit")
			return nil
		case mode != "watched-files" && len(id) > 0 && (len(obj["result"]) > 0 || len(obj["error"]) > 0):
			appendRecord(recordPath, string(message))
		}
	}
}

func appendRecord(path string, line string) {
	if path == "" {
		return
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.WriteString(line + "\n")
}
