package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A revision that starts with "-" would reach git as one of its options:
// `--output=FILE` makes `git show` and `git diff` write FILE.
func TestRefsThatReadAsOptionsAreRefused(t *testing.T) {
	out := filepath.Join(t.TempDir(), "written")
	spec := "--output=" + out
	cases := map[string]func() error{
		"getFileContent ref": func() error {
			_, err := New(t.TempDir()).GetFileContent(context.Background(), mustJSON(t, map[string]string{"ref": spec, "relPath": "a.txt"}))
			return err
		},
		"blob ref": func() error {
			_, err := parseBlobParams(mustJSON(t, map[string]string{"ref": spec, "relPath": "a.txt"}))
			return err
		},
		"commitDetail sha": func() error {
			_, err := New(t.TempDir()).CommitDetail(context.Background(), mustJSON(t, map[string]string{"sha": spec}))
			return err
		},
		"diff from": func() error {
			_, err := parseDiffParams(mustJSON(t, map[string]string{"from": spec}))
			return err
		},
		"diff to": func() error {
			_, err := parseDiffParams(mustJSON(t, map[string]string{"to": spec}))
			return err
		},
		"log ref": func() error {
			_, err := parseLogParams(mustJSON(t, map[string]string{"ref": spec}))
			return err
		},
		"log afterSha": func() error {
			_, err := parseLogParams(mustJSON(t, map[string]string{"afterSha": spec}))
			return err
		},
	}
	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			err := call()
			if err == nil || !strings.Contains(err.Error(), "must not start with -") {
				t.Fatalf("err = %v, want the option-like ref refused", err)
			}
			if _, statErr := os.Stat(out); statErr == nil {
				t.Fatal("git wrote the --output file")
			}
		})
	}
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
