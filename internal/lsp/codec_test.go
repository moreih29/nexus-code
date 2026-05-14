package lsp

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

func TestDecoderTable(t *testing.T) {
	cases := []struct {
		name      string
		chunks    []string
		wantCount int
		wantError bool
	}{
		{
			name:      "split header",
			chunks:    splitString(string(mustFrame(t, map[string]any{"jsonrpc": "2.0", "method": "test/split"})), 11),
			wantCount: 1,
		},
		{
			name: "multi frame chunks",
			chunks: []string{
				string(mustFrame(t, map[string]any{"jsonrpc": "2.0", "method": "one"})) +
					string(mustFrame(t, map[string]any{"jsonrpc": "2.0", "method": "two"})),
			},
			wantCount: 2,
		},
		{
			name: "crlf headers",
			chunks: []string{
				crlfFrame(t, `{"jsonrpc":"2.0","method":"test/crlf"}`),
			},
			wantCount: 1,
		},
		{
			name:      "empty body",
			chunks:    []string{"Content-Length: 0\r\n\r\n"},
			wantError: true,
		},
		{
			name:      "protocol error",
			chunks:    []string{"Header: nope\r\n\r\n{}"},
			wantError: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			decoder := NewDecoder()
			var got []json.RawMessage
			var err error
			for _, chunk := range tc.chunks {
				var messages []json.RawMessage
				messages, err = decoder.Append([]byte(chunk))
				got = append(got, messages...)
				if err != nil {
					break
				}
			}
			if tc.wantError {
				if err == nil {
					t.Fatal("expected protocol error")
				}
				return
			}
			if err != nil {
				t.Fatalf("Append() error = %v", err)
			}
			if len(got) != tc.wantCount {
				t.Fatalf("decoded %d messages, want %d", len(got), tc.wantCount)
			}
			for _, msg := range got {
				if !strings.Contains(string(msg), `"jsonrpc":"2.0"`) {
					t.Fatalf("decoded message missing jsonrpc marker: %s", msg)
				}
			}
		})
	}
}

func mustFrame(t *testing.T, message any) []byte {
	t.Helper()
	frame, err := EncodeMessage(message)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func splitString(value string, index int) []string {
	return []string{value[:index], value[index:]}
}

func crlfFrame(t *testing.T, body string) string {
	t.Helper()
	return "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n" +
		"Content-Length: " + strconv.Itoa(len(body)) + "\r\n\r\n" +
		body
}
