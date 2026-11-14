package search

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func findFiles(t *testing.T, service *Service, query string, limit int) FilesResult {
	t.Helper()
	got, err := service.Files(context.Background(), mustJSON(t, FilesParams{Query: query, Limit: limit}))
	if err != nil {
		t.Fatal(err)
	}
	return got.(FilesResult)
}

func writeFiles(t *testing.T, root string, paths ...string) {
	t.Helper()
	for _, p := range paths {
		abs := filepath.Join(root, filepath.FromSlash(p))
		must(t, os.MkdirAll(filepath.Dir(abs), 0o755))
		must(t, os.WriteFile(abs, nil, 0o644))
	}
}

func TestFilesFindsByNameBestFirst(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root,
		"src/components/chat/composer.tsx",
		"src/components/chat/composer-model.ts",
		"src/compose/router.ts",
		"docs/composition.md",
		"src/main/commands/open.ts",
		"bun.lock",
		"report.pdf",
	)
	service := mustSearch(t, root)

	got := findFiles(t, service, "composer", 10)
	if got.Truncated {
		t.Fatal("a small tree should be walked whole")
	}
	// The file named so, before the one named so and more, before a scattered match.
	want := []string{"src/components/chat/composer.tsx", "src/components/chat/composer-model.ts"}
	if len(got.Files) < 2 || !slices.Equal(got.Files[:2], want) {
		t.Fatalf("composer: got %v, want %v first", got.Files, want)
	}
	if slices.Contains(got.Files, "src/main/commands/open.ts") {
		t.Fatalf("open.ts has no r after its e: %v", got.Files)
	}

	// Word starts beat letters in the middle: "cmo" starts composer-model's two words.
	if got := findFiles(t, service, "cmo", 10); len(got.Files) == 0 || got.Files[0] != "src/components/chat/composer-model.ts" {
		t.Fatalf("cmo: got %v", got.Files)
	}
	// Case and spaces are not minded; a path's folders count.
	if got := findFiles(t, service, "Chat Comp", 10); len(got.Files) == 0 || got.Files[0] != "src/components/chat/composer.tsx" {
		t.Fatalf("Chat Comp: got %v", got.Files)
	}
	if got := findFiles(t, service, `chat\composer.tsx`, 10); !slices.Equal(got.Files, []string{"src/components/chat/composer.tsx"}) {
		t.Fatalf(`backslash: got %v`, got.Files)
	}
	// Files text search leaves out by name are found here; binaries and empty ones too.
	if got := findFiles(t, service, "bun.lock", 10); !slices.Contains(got.Files, "bun.lock") {
		t.Fatalf("bun.lock: got %v", got.Files)
	}
	if got := findFiles(t, service, "pdf", 10); !slices.Contains(got.Files, "report.pdf") {
		t.Fatalf("pdf: got %v", got.Files)
	}
	if got := findFiles(t, service, "zzz", 10); len(got.Files) != 0 {
		t.Fatalf("zzz: got %v", got.Files)
	}
}

func TestFilesLeavesOutWhatTextSearchSkipsAndKeepsTheLimit(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root,
		"node_modules/pkg/index.js",
		".git/config",
		"build/index.js",
		"coverage/index.js",
		"src/index.js",
		".DS_Store",
		"a/index.js",
		"b/index.js",
	)
	service := mustSearch(t, root)

	got := findFiles(t, service, "index", 10)
	want := []string{"a/index.js", "b/index.js", "src/index.js"}
	if !slices.Equal(got.Files, want) {
		t.Fatalf("index: got %v, want %v", got.Files, want)
	}
	if got := findFiles(t, service, "index", 2); !slices.Equal(got.Files, want[:2]) {
		t.Fatalf("limit 2: got %v", got.Files)
	}
	if got := findFiles(t, service, "DS_Store", 10); len(got.Files) != 0 {
		t.Fatalf(".DS_Store is hidden: %v", got.Files)
	}
}

func TestFilesRefusesNoQuery(t *testing.T) {
	service := mustSearch(t, t.TempDir())
	for _, params := range []string{``, `{}`, `{"query":"   "}`} {
		if _, err := service.Files(context.Background(), []byte(params)); err == nil {
			t.Fatalf("%q: expected an error", params)
		}
	}
}

func TestFuzzyScorePrefersTogetherAndNameStarts(t *testing.T) {
	q := foldQuery("abc")
	together, ok := fuzzyScore("x/abc.ts", q)
	if !ok {
		t.Fatal("abc is in x/abc.ts")
	}
	apart, ok := fuzzyScore("x/a_b_c.ts", q)
	if !ok {
		t.Fatal("abc is in x/a_b_c.ts")
	}
	middle, ok := fuzzyScore("x/zzabc.ts", q)
	if !ok {
		t.Fatal("abc is in x/zzabc.ts")
	}
	if together <= middle {
		t.Fatalf("at the name's start (%d) should beat in its middle (%d)", together, middle)
	}
	if apart <= middle {
		t.Fatalf("three word starts (%d) should beat the middle of a word (%d)", apart, middle)
	}
	if _, ok := fuzzyScore("x/acb.ts", q); ok {
		t.Fatal("abc is not in order in acb")
	}
}
