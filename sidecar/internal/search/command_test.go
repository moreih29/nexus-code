package search

import (
	"reflect"
	"testing"

	"nexus-code/sidecar/internal/contracts"
)

func TestBuildRipgrepArgsSupportsSearchOptions(t *testing.T) {
	args := BuildRipgrepArgs("foo", contracts.SearchOptions{
		CaseSensitive: false,
		Regex:         false,
		WholeWord:     true,
		IncludeGlobs:  []string{"*.go", " src/**/*.ts "},
		ExcludeGlobs:  []string{"vendor/**", "!dist/**"},
		UseGitIgnore:  boolPtr(false),
	})

	want := []string{
		"--json",
		"--line-number",
		"--column",
		"--with-filename",
		"--color", "never",
		"--ignore-case",
		"--fixed-strings",
		"--word-regexp",
		"--no-ignore",
		"--glob", "*.go",
		"--glob", "src/**/*.ts",
		"--glob", "!vendor/**",
		"--glob", "!dist/**",
		"--", "foo", ".",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args mismatch:\nwant %#v\n got %#v", want, args)
	}
}

func TestBuildRipgrepArgsRespectsGitignoreByDefault(t *testing.T) {
	args := BuildRipgrepArgs("foo", contracts.SearchOptions{
		CaseSensitive: true,
		Regex:         true,
	})
	for _, arg := range args {
		if arg == "--no-ignore" || arg == "--ignore-case" || arg == "--fixed-strings" {
			t.Fatalf("unexpected arg %q in %#v", arg, args)
		}
	}
}

func boolPtr(value bool) *bool { return &value }
