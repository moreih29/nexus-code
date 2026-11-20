package chat

import (
	"bytes"
	"strings"
	"unicode/utf8"
)

// decodeOutput turns program output into valid UTF-8, line by line. Valid
// UTF-8 lines are kept as they are. Other lines are read with the platform's
// legacy code page (Windows programs such as cmd.exe write OEM/ANSI text),
// or have their invalid bytes dropped when that is unavailable. Line breaks
// stay as written, so UTF-8 and legacy lines may be mixed.
func decodeOutput(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	for _, line := range bytes.SplitAfter(b, []byte("\n")) {
		switch {
		case utf8.Valid(line):
			out.Write(line)
		default:
			if s, ok := decodeLegacyCodePage(line); ok {
				out.WriteString(s)
			} else {
				out.WriteString(strings.ToValidUTF8(string(line), ""))
			}
		}
	}
	return out.String()
}
