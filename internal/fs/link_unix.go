//go:build !windows

package fs

import "errors"

// symlinkFallback stands in for a symbolic link the agent could not create.
// Elsewhere than on Windows there is nothing to stand in: err is returned.
func symlinkFallback(_, _, _ string, err error) error {
	return err
}

// Junction is Windows's: elsewhere a symbolic link links a folder.
func Junction(_, _ string) error {
	return errors.ErrUnsupported
}
