//go:build !windows

package fs

import "context"

func symlinkFallback(_ context.Context, _, _, _ string, err error) (bool, error) {
	return false, err
}
