package proto

import (
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

func TestErrorResponseNamesNoPathOfAnUncodedError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "home", "secret.json")
	for _, err := range []error{
		&fs.PathError{Op: "open", Path: path, Err: fs.ErrPermission},
		fmt.Errorf("reading: %w", &fs.PathError{Op: "read", Path: path, Err: fs.ErrNotExist}),
	} {
		resp := ErrorResponse("1", err)
		if resp.Error == nil || resp.Error.Code != CodeRequestFailed || strings.Contains(resp.Error.Message, "secret") || resp.Error.Message == "" {
			t.Fatalf("%v: %+v", err, resp.Error)
		}
	}
	resp := ErrorResponse("1", RequestFailed("x: %s", "kept"))
	if resp.Error.Message != "x: kept" {
		t.Fatalf("a coded error's message changed: %+v", resp.Error)
	}
}
