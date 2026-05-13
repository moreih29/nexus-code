package search

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestTextSearchFindsMatchesAndSkipsDefaults(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "one.ts"), []byte("needle\nneedle again\n"), 0o644))
	must(t, os.Mkdir(filepath.Join(root, "nested"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "nested", "two.ts"), []byte("prefix needle suffix\n"), 0o644))
	must(t, os.Mkdir(filepath.Join(root, "node_modules"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "node_modules", "skip.ts"), []byte("needle\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "binary.bin"), []byte{'n', 0, 'd'}, 0o644))

	service := mustSearch(t, root)
	var batches []ProgressPayload
	service.SetEventSink(func(event string, payload any) error {
		if event == "search.progress" {
			batches = append(batches, payload.(ProgressPayload))
		}
		return nil
	})

	resultAny, err := service.Text(context.Background(), mustJSON(t, Params{
		SearchID: "s1",
		Query: Query{
			Pattern:         "needle",
			IsCaseSensitive: true,
			MaxResults:      2000,
			MaxFileSize:     defaultMaxFileSize,
		},
	}))
	must(t, err)

	result := resultAny.(Complete)
	if result.FilesScanned != 2 || result.MatchesFound != 3 || result.LimitHit {
		t.Fatalf("search result mismatch: %+v", result)
	}
	if len(batches) != 1 {
		t.Fatalf("expected one progress batch, got %d", len(batches))
	}
	paths := []string{}
	for _, match := range batches[0].Batch {
		paths = append(paths, match.RelPath)
	}
	if len(paths) != 2 || !containsPath(paths, "one.ts") || !containsPath(paths, "nested/two.ts") {
		t.Fatalf("unexpected paths: %v", paths)
	}
}

func TestTextSearchInvalidRegexAndLimit(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("x x x\n"), 0o644))
	service := mustSearch(t, root)

	_, err := service.Text(context.Background(), mustJSON(t, Params{
		SearchID: "bad",
		Query:    Query{Pattern: "[invalid", IsRegExp: true},
	}))
	if err == nil {
		t.Fatal("expected invalid regex error")
	}

	resultAny, err := service.Text(context.Background(), mustJSON(t, Params{
		SearchID: "limit",
		Query: Query{
			Pattern:         "x",
			IsCaseSensitive: true,
			MaxResults:      2,
			MaxFileSize:     defaultMaxFileSize,
		},
	}))
	must(t, err)
	result := resultAny.(Complete)
	if result.MatchesFound != 2 || !result.LimitHit {
		t.Fatalf("limit mismatch: %+v", result)
	}
}

func mustSearch(t *testing.T, root string) *Service {
	t.Helper()
	service, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func containsPath(paths []string, target string) bool {
	for _, path := range paths {
		if path == target {
			return true
		}
	}
	return false
}
