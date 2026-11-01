package git

import (
	"errors"
	"path/filepath"
	"reflect"
	"testing"
)

func TestGitInstallPathsOnWindows(t *testing.T) {
	env := map[string]string{
		"ProgramW6432":      `C:\Program Files`,
		"ProgramFiles(x86)": `C:\Program Files (x86)`,
		"ProgramFiles":      `C:\Program Files`,
		"LOCALAPPDATA":      `C:\Users\u\AppData\Local`,
	}
	got := gitInstallPaths("windows", func(key string) string { return env[key] })
	want := []string{
		filepath.Join(`C:\Program Files`, "Git", "cmd", "git.exe"),
		filepath.Join(`C:\Program Files (x86)`, "Git", "cmd", "git.exe"),
		filepath.Join(`C:\Program Files`, "Git", "cmd", "git.exe"),
		filepath.Join(`C:\Users\u\AppData\Local`, "Programs", "Git", "cmd", "git.exe"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("gitInstallPaths = %q, want %q", got, want)
	}
	if got := gitInstallPaths("windows", func(string) string { return "" }); len(got) != 0 {
		t.Fatalf("gitInstallPaths without the variables = %q, want none", got)
	}
	if got := gitInstallPaths("linux", func(key string) string { return env[key] }); len(got) != 0 {
		t.Fatalf("gitInstallPaths on linux = %q, want none", got)
	}
}

func TestFindGitPrefersPath(t *testing.T) {
	onPath := func(string) (string, error) { return `C:\bin\git.exe`, nil }
	if got := findGit(onPath, []string{`C:\Git\cmd\git.exe`}, func(string) bool { return true }); got != "git" {
		t.Fatalf("findGit = %q, want git from PATH", got)
	}
}

// Git installed with "Use Git from Git Bash only" is off PATH but in its
// install location.
func TestFindGitFallsBackToInstallLocation(t *testing.T) {
	offPath := func(string) (string, error) { return "", errors.New("not found") }
	installed := map[string]bool{`C:\Users\u\AppData\Local\Programs\Git\cmd\git.exe`: true}
	candidates := []string{`C:\Program Files\Git\cmd\git.exe`, `C:\Users\u\AppData\Local\Programs\Git\cmd\git.exe`}

	got := findGit(offPath, candidates, func(p string) bool { return installed[p] })
	if got != candidates[1] {
		t.Fatalf("findGit = %q, want %q", got, candidates[1])
	}
	if got := findGit(offPath, candidates, func(string) bool { return false }); got != "git" {
		t.Fatalf("findGit with no git = %q, want git", got)
	}
}
