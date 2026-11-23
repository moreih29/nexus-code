package redact

import "regexp"

var (
	userinfo           = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)[^/\s?#"'<>]+@`)
	authorization      = regexp.MustCompile(`(?i)(\bauthorization\b["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?|\bbearer\s+)[^\s"';,]+`)
	assignment         = regexp.MustCompile(`(?i)(\b(?:token|[a-z0-9_]+_(?:key|token|secret))\b["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s"'&;,<>]+)`)
	argumentAssignment = regexp.MustCompile(`(?i)(^|\s)([a-z0-9_]+_(?:key|token|secret)\s*=).+$`)
)

func Credentials(s string) string {
	s = userinfo.ReplaceAllString(s, "${1}[REDACTED]@")
	s = authorization.ReplaceAllString(s, "${1}[REDACTED]")
	return assignment.ReplaceAllString(s, "${1}[REDACTED]")
}

func Argument(s string) string {
	return Credentials(argumentAssignment.ReplaceAllString(s, "${1}${2}[REDACTED]"))
}
