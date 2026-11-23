package claudefiles

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReasonDropsThePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret", "s.jsonl")
	_, openErr := os.Open(path)
	for _, err := range []error{
		openErr,
		fmt.Errorf("wrapped: %w", &fs.PathError{Op: "open", Path: path, Err: fs.ErrPermission}),
		&os.LinkError{Op: "rename", Old: path, New: path + "2", Err: errors.New("denied")},
		&fs.PathError{Op: "open", Path: path, Err: os.NewSyscallError("read", errors.New("locked"))},
	} {
		got := Reason(err)
		if got == "" || strings.Contains(got, "secret") {
			t.Fatalf("Reason(%v) = %q", err, got)
		}
	}
	if Reason(nil) != "" || Reason(errors.New("plain")) != "plain" {
		t.Fatal("Reason changed an error with no path")
	}
}
