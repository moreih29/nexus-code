//go:build !windows

package chat

func decodeLegacyCodePage(b []byte) (string, bool) { return "", false }
