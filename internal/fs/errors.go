package fs

import (
	"errors"
	"fmt"
	iofs "io/fs"
	"runtime"
	"strings"
)

const (
	CodeNotFound         = "NOT_FOUND"
	CodePermissionDenied = "PERMISSION_DENIED"
	CodeAlreadyExists    = "ALREADY_EXISTS"
	CodeIsDirectory      = "IS_DIRECTORY"
	CodeNotDirectory     = "NOT_DIRECTORY"
	CodeTooLarge         = "TOO_LARGE"
	CodeTransferTooLarge = "TRANSFER_TOO_LARGE"
	CodeOutOfWorkspace   = "OUT_OF_WORKSPACE"

	CodeStale       = "STALE"
	CodeNotEmpty    = "NOT_EMPTY"
	CodeCrossDevice = "CROSS_DEVICE"
	CodeNoSpace     = "NO_SPACE"
)

type FSError struct {
	Code string
	Path string
}

func (e FSError) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Path) }

func (e FSError) ErrorCode() string { return e.Code }

func mapPathError(err error, path string) error {
	var fsErr FSError
	if errors.As(err, &fsErr) {
		return FSError{Code: fsErr.Code, Path: path}
	}
	if errors.Is(err, iofs.ErrNotExist) {
		return FSError{Code: CodeNotFound, Path: path}
	}
	if errors.Is(err, iofs.ErrPermission) {
		return FSError{Code: CodePermissionDenied, Path: path}
	}
	if errors.Is(err, iofs.ErrExist) {
		return FSError{Code: CodeAlreadyExists, Path: path}
	}
	if runtime.GOOS == "windows" && strings.Contains(strings.ToLower(err.Error()), "access is denied") {
		return FSError{Code: CodePermissionDenied, Path: path}
	}
	return err
}
