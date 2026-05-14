package lsp

import (
	"encoding/json"
	"testing"
)

func TestWatchedFilesRouterMatchesGlobPatterns(t *testing.T) {
	registrations := parseWatchedFileRegistrations(json.RawMessage(`{
		"registrations": [
			{
				"id": "go",
				"method": "workspace/didChangeWatchedFiles",
				"registerOptions": {
					"watchers": [{ "globPattern": "**/*.go" }]
				}
			},
			{
				"id": "ts",
				"method": "workspace/didChangeWatchedFiles",
				"registerOptions": {
					"watchers": [{ "globPattern": "src/**/*.{ts,tsx}" }]
				}
			}
		]
	}`))
	if len(registrations) != 2 {
		t.Fatalf("registrations length = %d, want 2", len(registrations))
	}

	tests := []struct {
		name    string
		relPath string
		want    bool
	}{
		{name: "root go file", relPath: "main.go", want: true},
		{name: "nested go file", relPath: "internal/lsp/service.go", want: true},
		{name: "brace ts file", relPath: "src/main/index.ts", want: true},
		{name: "brace tsx file", relPath: "src/ui/App.tsx", want: true},
		{name: "extension mismatch", relPath: "src/main/index.js", want: false},
		{name: "directory mismatch", relPath: "testdata/App.tsx", want: false},
		{name: "unsafe rel path", relPath: "../main.go", want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := watchedFileRegistrationsMatch(registrations, test.relPath); got != test.want {
				t.Fatalf("watchedFileRegistrationsMatch(%q) = %v, want %v", test.relPath, got, test.want)
			}
		})
	}
}

func TestWatchedFilesRouterRoutesAllWhenNoUsableGlob(t *testing.T) {
	registrations := parseWatchedFileRegistrations(json.RawMessage(`{
		"registrations": [
			{
				"id": "all",
				"method": "workspace/didChangeWatchedFiles",
				"registerOptions": {
					"watchers": [
						{ "globPattern": 42 },
						{ "globPattern": "file:///workspace/**/*.go" }
					]
				}
			}
		]
	}`))
	if len(registrations) != 1 {
		t.Fatalf("registrations length = %d, want 1", len(registrations))
	}
	if !watchedFileRegistrationsMatch(registrations, "README.md") {
		t.Fatal("registration with no usable glob should match all workspace changes")
	}
}

func TestWatchedFilesRouterIgnoresUnrelatedRegistrations(t *testing.T) {
	registrations := parseWatchedFileRegistrations(json.RawMessage(`{
		"registrations": [
			{
				"id": "config",
				"method": "workspace/didChangeConfiguration",
				"registerOptions": {}
			}
		]
	}`))
	if len(registrations) != 0 {
		t.Fatalf("registrations length = %d, want 0", len(registrations))
	}
}
