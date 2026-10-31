//go:build !windows

package fs

// symlinkFallback stands in for a symbolic link the agent could not create.
// Elsewhere than on Windows there is nothing to stand in: err is returned.
func symlinkFallback(_, _, _ string, err error) error {
	return err
}
