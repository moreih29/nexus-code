//go:build windows

package hookserver

import (
	"errors"

	"golang.org/x/sys/windows"
)

// The syscall package's ECONNREFUSED is a placeholder on Windows, which
// reports a refused connection, to a Unix socket too, as WSAECONNREFUSED.
func isConnRefused(err error) bool {
	return errors.Is(err, windows.WSAECONNREFUSED)
}
