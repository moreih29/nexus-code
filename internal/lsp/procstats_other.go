//go:build !linux && !darwin && !windows

package lsp

import "errors"

func processTable() (map[int]processEntry, error) {
	return nil, errors.New("process memory is not available on this platform")
}
