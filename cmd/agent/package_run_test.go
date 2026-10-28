package main

import (
	"path/filepath"
	"testing"
)

func TestInDirTakesOnlyFilesInsideTheDirectory(t *testing.T) {
	dir := t.TempDir()
	for _, tc := range []struct {
		path string
		want bool
	}{
		{filepath.Join(dir, "app", "NexusCode.exe"), true},
		{filepath.Join(dir, "..", "elsewhere.exe"), false},
		{filepath.Join(dir, "app", "..", "..", "elsewhere.exe"), false},
		{dir, false},
		{filepath.Join("app", "NexusCode.exe"), false},
	} {
		if got := inDir(dir, tc.path); got != tc.want {
			t.Errorf("inDir(%q, %q) = %v, want %v", dir, tc.path, got, tc.want)
		}
	}
}

func TestPackageRunRefusesOutsideAPackage(t *testing.T) {
	if code := runPackageProgram([]string{filepath.Join(t.TempDir(), "program")}); code != 1 {
		t.Fatalf("runPackageProgram outside a package = %d, want 1", code)
	}
}
