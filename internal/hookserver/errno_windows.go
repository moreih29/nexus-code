//go:build windows

package hookserver

import (
	"errors"

	"golang.org/x/sys/windows"
)

func isConnRefused(err error) bool {
	return errors.Is(err, windows.WSAECONNREFUSED)
}
