// Package lsp implements the Go agent's generic JSON-RPC transport for
// Language Server Protocol processes.
package lsp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

const maxFrameBodyBytes = 64 * 1024 * 1024

var headerTerminator = []byte("\r\n\r\n")

// Decoder incrementally parses LSP Content-Length framed JSON-RPC messages.
type Decoder struct {
	buffer       []byte
	maxBodyBytes int
}

// NewDecoder constructs a streaming decoder with the package default body cap.
func NewDecoder() *Decoder {
	return &Decoder{maxBodyBytes: maxFrameBodyBytes}
}

// Append adds one transport chunk and returns every complete JSON-RPC body now
// available. Incomplete trailing data remains buffered for the next call.
func (d *Decoder) Append(chunk []byte) ([]json.RawMessage, error) {
	if len(chunk) > 0 {
		d.buffer = append(d.buffer, chunk...)
	}

	var messages []json.RawMessage
	for {
		sep := bytes.Index(d.buffer, headerTerminator)
		if sep < 0 {
			return messages, nil
		}

		contentLength, err := parseContentLength(d.buffer[:sep])
		if err != nil {
			return messages, err
		}
		if contentLength == 0 {
			return messages, fmt.Errorf("lsp frame has empty body")
		}
		if contentLength > d.maxBodyBytes {
			return messages, fmt.Errorf("lsp frame body exceeds %d byte limit", d.maxBodyBytes)
		}

		bodyStart := sep + len(headerTerminator)
		bodyEnd := bodyStart + contentLength
		if len(d.buffer) < bodyEnd {
			return messages, nil
		}

		body := append([]byte(nil), d.buffer[bodyStart:bodyEnd]...)
		if !json.Valid(body) {
			return messages, fmt.Errorf("lsp frame body is not valid JSON")
		}
		messages = append(messages, json.RawMessage(body))
		d.buffer = d.buffer[bodyEnd:]
	}
}

// EncodeMessage marshals a JSON-RPC object and wraps it in an LSP frame.
func EncodeMessage(message any) ([]byte, error) {
	body, err := json.Marshal(message)
	if err != nil {
		return nil, err
	}
	return encodeBody(body), nil
}

// EncodeRawMessage wraps an already-marshaled JSON-RPC object in an LSP frame.
func EncodeRawMessage(message json.RawMessage) ([]byte, error) {
	body := bytes.TrimSpace(message)
	if len(body) == 0 {
		return nil, fmt.Errorf("lsp message body is required")
	}
	if !json.Valid(body) {
		return nil, fmt.Errorf("lsp message body is not valid JSON")
	}
	if body[0] != '{' {
		return nil, fmt.Errorf("lsp message body must be a JSON object")
	}
	return encodeBody(body), nil
}

func encodeBody(body []byte) []byte {
	header := []byte(fmt.Sprintf("Content-Length: %d\r\n\r\n", len(body)))
	frame := make([]byte, 0, len(header)+len(body))
	frame = append(frame, header...)
	frame = append(frame, body...)
	return frame
}

func parseContentLength(header []byte) (int, error) {
	for _, line := range strings.Split(string(header), "\r\n") {
		name, value, ok := strings.Cut(line, ":")
		if !ok || !strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || n < 0 {
			return 0, fmt.Errorf("invalid Content-Length header")
		}
		return n, nil
	}
	return 0, fmt.Errorf("missing Content-Length header")
}
