package search

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
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

func TestTextSearchBoundsPreviewOnLongLines(t *testing.T) {
	root := t.TempDir()
	// One 256 KiB line: before the preview window existed, every one of the
	// thousand matches carried the whole line, a 256 MiB progress frame.
	long := strings.Repeat("é ab ", 256<<10/6)
	must(t, os.WriteFile(filepath.Join(root, "data.json"), []byte(long), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "short.ts"), []byte("const ab = 1\n"), 0o644))

	service := mustSearch(t, root)
	frameBytes := 0
	matches := map[string][]Match{}
	service.SetEventSink(func(event string, payload any) error {
		data, err := json.Marshal(payload)
		must(t, err)
		frameBytes += len(data)
		for _, fm := range payload.(ProgressPayload).Batch {
			matches[fm.RelPath] = append(matches[fm.RelPath], fm.Matches...)
		}
		return nil
	})
	_, err := service.Text(context.Background(), mustJSON(t, Params{
		SearchID: "long",
		Query:    Query{Pattern: "ab", IsCaseSensitive: true, MaxResults: 2000},
	}))
	must(t, err)

	if got := matches["short.ts"]; len(got) != 1 || got[0].Preview != "const ab = 1" || got[0].PreviewStart != 0 {
		t.Fatalf("short line preview changed: %+v", got)
	}
	got := matches["data.json"]
	if len(got) != perFileMatchCap {
		t.Fatalf("long line matches = %d, want %d", len(got), perFileMatchCap)
	}
	for _, m := range got {
		if len(m.Preview) > previewMaxBytes || !utf8.ValidString(m.Preview) {
			t.Fatalf("preview not bounded/valid: len=%d %+v", len(m.Preview), m.Range)
		}
		// Range stays line-relative; PreviewStart maps it into the preview.
		start, end := m.Range.StartCol-m.PreviewStart, m.Range.EndCol-m.PreviewStart
		if start < 0 || end > len(m.Preview) || m.Preview[start:end] != "ab" || long[m.Range.StartCol:m.Range.EndCol] != "ab" {
			t.Fatalf("range does not map into preview: start=%d %+v", m.PreviewStart, m.Range)
		}
	}
	if frameBytes > 2<<20 {
		t.Fatalf("progress frames total %d bytes for a %d byte file", frameBytes, len(long))
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

// splitLines runs once per searched file. It used to compile its line-break
// regexp on every call: 23 allocations for a four-line string, against 6
// with the pattern compiled once.
func TestSplitLinesReusesCompiledPattern(t *testing.T) {
	text := "alpha\r\nbeta\ngamma\rdelta"
	got := splitLines(text)
	if want := []string{"alpha", "beta", "gamma", "delta"}; !slices.Equal(got, want) {
		t.Fatalf("splitLines(%q) = %q, want %q", text, got, want)
	}
	allocs := testing.AllocsPerRun(100, func() { splitLines(text) })
	if allocs > 12 {
		t.Fatalf("splitLines allocated %v times per call; the pattern is being recompiled", allocs)
	}
}
