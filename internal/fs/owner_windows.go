//go:build windows

package fs

import "os"

// needsInPlaceWrite reports false: a Windows file has no POSIX owner for the
// replacement to lose, and os.FileInfo does not report its hard links, so
// every file is replaced atomically.
func needsInPlaceWrite(os.FileInfo) bool {
	return false
}

// keepGroup does nothing: a Windows file has no POSIX group.
func keepGroup(string, os.FileInfo) {}
