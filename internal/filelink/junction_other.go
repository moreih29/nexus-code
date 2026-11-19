//go:build !windows

package filelink

import "errors"

// Junction is Windows's: elsewhere a symbolic link links a folder.
func Junction(_, _ string) error {
	return errors.ErrUnsupported
}
