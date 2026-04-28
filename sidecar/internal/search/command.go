package search

import (
	"strings"

	"nexus-code/sidecar/internal/contracts"
)

func BuildRipgrepArgs(query string, options contracts.SearchOptions) []string {
	args := []string{
		"--json",
		"--line-number",
		"--column",
		"--with-filename",
		"--color", "never",
	}

	if !options.CaseSensitive {
		args = append(args, "--ignore-case")
	}
	if !options.Regex {
		args = append(args, "--fixed-strings")
	}
	if options.WholeWord {
		args = append(args, "--word-regexp")
	}
	if options.UseGitIgnore != nil && !*options.UseGitIgnore {
		args = append(args, "--no-ignore")
	}
	for _, glob := range options.IncludeGlobs {
		trimmed := strings.TrimSpace(glob)
		if trimmed == "" {
			continue
		}
		args = append(args, "--glob", trimmed)
	}
	for _, glob := range options.ExcludeGlobs {
		trimmed := strings.TrimSpace(glob)
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "!") {
			trimmed = "!" + trimmed
		}
		args = append(args, "--glob", trimmed)
	}

	return append(args, "--", query, ".")
}
