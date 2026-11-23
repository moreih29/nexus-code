package chat

import (
	"bytes"
	"strings"
	"unicode/utf8"
)

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
