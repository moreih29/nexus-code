//go:build windows

package chat

import "testing"

func TestDecodeLegacyCodePageCP949(t *testing.T) {
	if page, _, _ := procGetOEMCP.Call(); page != 949 {
		t.Skip("OEM code page is not CP949")
	}
	raw := []byte{0xB3, 0xBB, 0xBA, 0xCE, ' ', 0xB8, 0xED, 0xB7, 0xC9}
	if got := decodeOutput(raw); got != "내부 명령" {
		t.Fatalf("got %q", got)
	}
}

func TestDecodeOutputMixedLines(t *testing.T) {
	if page, _, _ := procGetOEMCP.Call(); page != 949 {
		t.Skip("OEM code page is not CP949")
	}
	raw := append([]byte("한글 UTF-8 줄\r\n"), 0xB3, 0xBB, 0xBA, 0xCE, '\r', '\n')
	raw = append(raw, []byte("끝")...)
	if got := decodeOutput(raw); got != "한글 UTF-8 줄\r\n내부\r\n끝" {
		t.Fatalf("got %q", got)
	}
}
