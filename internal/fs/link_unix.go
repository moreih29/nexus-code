//go:build !windows

package fs

import "context"

// symlinkFallback stands in for a symbolic link the agent could not create.
// Elsewhere than on Windows there is nothing to stand in: err is returned.
func symlinkFallback(_ context.Context, _, _, _ string, err error) (bool, error) {
	return false, err
}
