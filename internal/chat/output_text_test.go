package chat

import "testing"

func TestDecodeOutputKeepsValidUTF8(t *testing.T) {
	in := "'node'은(는) 내부 또는 외부 명령"
	if got := decodeOutput([]byte(in)); got != in {
		t.Fatalf("got %q", got)
	}
}

func TestTrimLeadingPartialRune(t *testing.T) {
	b := []byte("은x")
	got := string(trimLeadingPartialRune(b[1:]))
	if got != "x" {
		t.Fatalf("got %q", got)
	}
	if got := string(trimLeadingPartialRune([]byte("한"))); got != "한" {
		t.Fatalf("got %q", got)
	}
}
