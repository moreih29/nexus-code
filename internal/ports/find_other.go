//go:build !linux && !darwin && !windows

package ports

import "errors"

// Find is not available here.
func Find([]int) ([]Port, error) {
	return nil, errors.New("listening ports are not available on this platform")
}
