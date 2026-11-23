//go:build !linux && !darwin && !windows

package ports

import "errors"

func Find([]int) ([]Port, error) {
	return nil, errors.New("listening ports are not available on this platform")
}
