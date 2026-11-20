package chat

import "testing"

func TestDecodeOutputKeepsValidUTF8(t *testing.T) {
	in := "'node'은(는) 내부 또는 외부 명령\r\n"
	if got := decodeOutput([]byte(in)); got != in {
		t.Fatalf("got %q", got)
	}
}

func TestDecodeOutputDropsInvalidBytesWithoutLegacyPage(t *testing.T) {
	if _, ok := decodeLegacyCodePage([]byte{0xB3}); ok {
		t.Skip("platform has a legacy code page")
	}
	if got := decodeOutput([]byte("a\xB3b\n한글\n")); got != "ab\n한글\n" {
		t.Fatalf("got %q", got)
	}
}
