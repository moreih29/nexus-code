package fs

import (
	"errors"
	"testing"
)

func TestMapPathErrorNamesThePathAskedFor(t *testing.T) {
	err := mapPathError(FSError{Code: CodeOutOfWorkspace, Path: "/real/elsewhere/a.txt"}, "/ws/link/a.txt")
	var fsErr FSError
	if !errors.As(err, &fsErr) || fsErr.Code != CodeOutOfWorkspace || fsErr.Path != "/ws/link/a.txt" {
		t.Fatalf("err = %v", err)
	}
}
