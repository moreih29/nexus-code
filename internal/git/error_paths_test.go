package git

import (
	"io/fs"
	"strings"
	"testing"
)

func TestGitStartErrorNamesNoPath(t *testing.T) {
	err := mapGitStartError(&fs.PathError{Op: "fork/exec", Path: "/private/tools/git", Err: fs.ErrPermission}, nil)
	if err == nil || strings.Contains(err.Error(), "/private/tools") {
		t.Fatalf("err = %v", err)
	}
}
