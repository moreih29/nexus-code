package chat

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	// The tests' programs get the test's environment, not the login shell
	// of whoever runs them.
	loginEnv = func() map[string]string { return nil }
	os.Exit(m.Run())
}

func TestParseLoginEnvKeepsWhatTheShellExports(t *testing.T) {
	out := "Welcome to the host\n" + loginEnvStart +
		"ANTHROPIC_BASE_URL=https://gw.example.com\x00" +
		"GW_KEY=a=b\x00" +
		"NOTE=two\nlines\x00" +
		"PWD=/home/me\x00OLDPWD=/\x00SHLVL=2\x00_=/usr/bin/env\x00TERM=dumb\x00" +
		"TERM_PROGRAM=iTerm.app\x00ZDOTDIR=/home/me/.zsh\x00NEXUS_TAB_ID=t1\x00" +
		"ELECTRON_RUN_AS_NODE=1\x00CLAUDECODE=1\x00" +
		loginEnvEnd + "bye\n"
	want := map[string]string{
		"ANTHROPIC_BASE_URL": "https://gw.example.com",
		"GW_KEY":             "a=b",
		"NOTE":               "two\nlines",
	}
	if got := parseLoginEnv(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("parseLoginEnv = %q, want %q", got, want)
	}
	for _, broken := range []string{"", "no markers", loginEnvStart + "A=1\x00"} {
		if got := parseLoginEnv(broken); got != nil {
			t.Fatalf("parseLoginEnv(%q) = %q, want nil", broken, got)
		}
	}
}

// fakeLoginShell makes a $SHELL that exports GW_KEY in its startup and
// counts its runs in the file it returns.
func fakeLoginShell(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no login shell")
	}
	dir := t.TempDir()
	runs := filepath.Join(dir, "runs")
	shell := filepath.Join(dir, "sh")
	script := "#!/bin/sh\n" +
		"[ \"$1\" = -ilc ] || exit 9\n" +
		"echo run >> '" + runs + "'\n" +
		"echo 'motd from the profile'\n" +
		"GW_KEY=secret; export GW_KEY\n" +
		"exec /bin/sh -c \"$2\"\n"
	if err := os.WriteFile(shell, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", shell)
	return runs
}

func TestReadLoginEnvAsksTheLoginShell(t *testing.T) {
	fakeLoginShell(t)
	env := readLoginEnv()
	if env["GW_KEY"] != "secret" {
		t.Fatalf("GW_KEY = %q, want the profile's", env["GW_KEY"])
	}
	if _, ok := env["PWD"]; ok {
		t.Fatalf("the shell's folder came along: %q", env["PWD"])
	}
}

func TestMergeEnvPutsTheLoginShellBetweenTheAgentAndTheTab(t *testing.T) {
	t.Setenv("GW_BASE", "agent")
	t.Setenv("GW_AGENT_ONLY", "kept")
	was := loginEnv
	loginEnv = func() map[string]string {
		return map[string]string{"GW_BASE": "login", "GW_KEY": "k", "PATH": "/login/bin"}
	}
	t.Cleanup(func() { loginEnv = was })

	got := map[string]string{}
	for _, entry := range mergeEnv(map[string]string{"PATH": "/tab/bin"}) {
		key, value, _ := strings.Cut(entry, "=")
		got[key] = value
	}
	for key, want := range map[string]string{
		"GW_BASE":       "login",
		"GW_KEY":        "k",
		"GW_AGENT_ONLY": "kept",
		"PATH":          "/tab/bin",
	} {
		if got[key] != want {
			t.Errorf("%s = %q, want %q", key, got[key], want)
		}
	}
}
