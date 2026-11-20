package chat

import (
	"strings"
	"unicode/utf8"
)

// decodeOutput turns program output into valid UTF-8. Valid UTF-8 is returned
// unchanged. Otherwise the platform's legacy code page is tried (Windows
// programs such as cmd.exe write OEM/ANSI text), and invalid bytes are
// dropped when that is unavailable or fails.
func decodeOutput(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	if s, ok := decodeLegacyCodePage(b); ok {
		return s
	}
	return strings.ToValidUTF8(string(b), "")
}

// trimLeadingPartialRune drops continuation bytes left at the start of a tail
// cut from the middle of a multibyte character.
func trimLeadingPartialRune(b []byte) []byte {
	for len(b) > 0 && !utf8.RuneStart(b[0]) {
		b = b[1:]
	}
	return b
}
