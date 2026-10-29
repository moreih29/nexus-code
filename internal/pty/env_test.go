package pty

import (
	"os"
	"strings"
	"testing"
)

// pathValues returns the values env gives PATH, under any name PATH has.
func pathValues(env []string) []string {
	var values []string
	for _, entry := range env {
		key, value, _ := strings.Cut(entry, "=")
		if sameEnvKey(key, "PATH") {
			values = append(values, value)
		}
	}
	return values
}

func TestMergeEnvPutsWrapperDirFirstOnPath(t *testing.T) {
	t.Setenv("PATH", "base")

	env := mergeEnv(map[string]string{wrapperDirEnv: "wrap"})

	want := "wrap" + string(os.PathListSeparator) + "base"
	if got := pathValues(env); len(got) != 1 || got[0] != want {
		t.Fatalf("PATH = %q, want [%q]", got, want)
	}
}

func TestMergeEnvKeepsPathOverrideOverWrapperDir(t *testing.T) {
	t.Setenv("PATH", "base")

	env := mergeEnv(map[string]string{wrapperDirEnv: "wrap", "PATH": "mine"})

	if got := pathValues(env); len(got) != 1 || got[0] != "mine" {
		t.Fatalf("PATH = %q, want [\"mine\"]", got)
	}
}

func TestMergeEnvLeavesPathWithoutWrapperDir(t *testing.T) {
	t.Setenv("PATH", "base")

	env := mergeEnv(nil)

	if got := pathValues(env); len(got) != 1 || got[0] != "base" {
		t.Fatalf("PATH = %q, want [\"base\"]", got)
	}
}
