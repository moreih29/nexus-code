package lsp

import "testing"

func TestFileURIWindowsDrivePath(t *testing.T) {
	cases := map[string]string{
		`C:\work\demo`:            "file:///c%3A/work/demo",
		`C:\work\my demo\main.ts`: "file:///c%3A/work/my%20demo/main.ts",
		`d:/src/project`:          "file:///d%3A/src/project",
	}
	for path, want := range cases {
		if got := fileURI(path); got != want {
			t.Errorf("fileURI(%q) = %q, want %q", path, got, want)
		}
	}
}
