package fs

import (
	"errors"
	"fmt"
	iofs "io/fs"
	"runtime"
	"strings"
)

// Error codes carried in the NDJSON error frame for fs.* methods.
// Mirrors `src/shared/protocol/agent/errors.ts`.
const (
	CodeNotFound         = "NOT_FOUND"
	CodePermissionDenied = "PERMISSION_DENIED"
	CodeAlreadyExists    = "ALREADY_EXISTS"
	CodeIsDirectory      = "IS_DIRECTORY"
	CodeNotDirectory     = "NOT_DIRECTORY"
	CodeTooLarge         = "TOO_LARGE"
	CodeOutOfWorkspace   = "OUT_OF_WORKSPACE"

	// New for fs.writeFile / fs.rmdir / fs.rename.
	CodeStale       = "STALE"        // expected mismatch (optimistic concurrency)
	CodeNotEmpty    = "NOT_EMPTY"    // rmdir against non-empty directory
	CodeCrossDevice = "CROSS_DEVICE" // rename across filesystems (EXDEV)
	CodeNoSpace     = "NO_SPACE"     // disk full during writeFile (ENOSPC)
)

// FSError carries a stable wire code plus a human-readable path fragment.
type FSError struct {
	Code string
	Path string
}

// Error implements the standard error interface. The "CODE: path" shape is
// intentionally compatible with the renderer's hasFsErrorCode helper.
func (e FSError) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Path) }

// ErrorCode exposes the wire code to proto.ErrorCode without coupling proto to
// this concrete type.
func (e FSError) ErrorCode() string { return e.Code }

// mapPathError translates syscall-flavored errors into the fs wire vocabulary.
func mapPathError(err error, path string) error {
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
