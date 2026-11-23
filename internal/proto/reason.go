package proto

import (
	"errors"
	"io/fs"
	"os"
)

func Reason(err error) string {
	for {
		var pathErr *fs.PathError
		var linkErr *os.LinkError
		var syscallErr *os.SyscallError
		switch {
		case errors.As(err, &pathErr):
			err = pathErr.Err
		case errors.As(err, &linkErr):
			err = linkErr.Err
		case errors.As(err, &syscallErr):
			err = syscallErr.Err
		default:
			if err == nil {
				return ""
			}
			return err.Error()
		}
	}
}
