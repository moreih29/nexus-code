//go:build !windows

package filelink

import "errors"

func Junction(_, _ string) error {
	return errors.ErrUnsupported
}
