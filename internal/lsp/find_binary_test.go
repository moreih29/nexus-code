package lsp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// TestMain lets the test binary stand in for rustup: a test copies it in as
// rustup and links its proxies to it, and findBinary runs `rustup which`.
func TestMain(m *testing.M) {
	if strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe") == "rustup" {
		os.Exit(fakeRustup(os.Args[1:]))
	}
	os.Exit(m.Run())
}

// fakeRustup answers `rustup which <tool>`. The toolchain has the tool when
// the directory it runs in has a file named has-<tool>, as a
// rust-toolchain.toml there picks a toolchain.
func fakeRustup(args []string) int {
	if len(args) != 2 || args[0] != "which" {
		return 2
	}
	if _, err := os.Stat("has-" + args[1]); err != nil {
		fmt.Fprintf(os.Stderr, "error: unknown binary '%s' in official toolchain\n", args[1])
		return 1
	}
	fmt.Println(args[1])
	return 0
}

// installRustup puts a copy of the test binary in dir as rustup and returns
// its path. A copy, not a link: Windows cannot delete a link of the running
// test binary when the test is done.
func installRustup(t *testing.T, dir string) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	rustup := filepath.Join(dir, "rustup")
	if runtime.GOOS == "windows" {
		rustup += ".exe"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rustup, data, 0o755); err != nil {
		t.Fatal(err)
	}
	return rustup
}

// linkRustupProxy links a proxy for tool to the rustup in its directory, as
// rustup installs them, and returns its path.
func linkRustupProxy(t *testing.T, rustup, tool string) string {
	t.Helper()
	proxy := filepath.Join(filepath.Dir(rustup), tool+filepath.Ext(rustup))
	if err := os.Link(rustup, proxy); err != nil {
		t.Fatal(err)
	}
	return proxy
}

func writeExecutable(t *testing.T, dir, name string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFindBinaryTriesTheUsersPathFirst(t *testing.T) {
	root := t.TempDir()
	onPath := writeExecutable(t, filepath.Join(root, "bin"), "gopls")
	theirs := writeExecutable(t, filepath.Join(root, "custom"), "gopls")

	if got := findBinary("gopls", theirs, "", []string{filepath.Dir(onPath)}); got != theirs {
		t.Fatalf("findBinary() = %q, want the user's %q", got, theirs)
	}
	// Nothing where the user said: the search goes on.
	missing := filepath.Join(root, "nowhere", "gopls")
	if got := findBinary("gopls", missing, "", []string{filepath.Dir(onPath)}); got != onPath {
		t.Fatalf("findBinary() = %q, want %q", got, onPath)
	}
}

func TestFindBinaryAddsExeToTheUsersPathOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("only Windows leaves the extension out")
	}
	root := t.TempDir()
	theirs := writeExecutable(t, filepath.Join(root, "custom"), "gopls")

	withoutExe := strings.TrimSuffix(theirs, ".exe")
	if got := findBinary("gopls", withoutExe, "", nil); got != theirs {
		t.Fatalf("findBinary() = %q, want %q", got, theirs)
	}
}

func TestFindBinarySearchesTheDirectoriesInOrder(t *testing.T) {
	root := t.TempDir()
	first := writeExecutable(t, filepath.Join(root, "a"), "rust-analyzer")
	_ = writeExecutable(t, filepath.Join(root, "b"), "rust-analyzer")

	dirs := []string{"", filepath.Join(root, "empty"), filepath.Dir(first), filepath.Join(root, "b")}
	if got := findBinary("rust-analyzer", "", "", dirs); got != first {
		t.Fatalf("findBinary() = %q, want %q", got, first)
	}
	if got := findBinary("gopls", "", "", dirs); got != "" {
		t.Fatalf("findBinary() = %q for a binary that is nowhere", got)
	}
}

func TestFindBinarySkipsAFileThatCannotRun(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no execute bit")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "gopls"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := findBinary("gopls", "", "", []string{dir}); got != "" {
		t.Fatalf("findBinary() = %q, a file without the execute bit", got)
	}
}

func TestFindBinarySkipsARustupProxyWhoseToolchainLacksTheTool(t *testing.T) {
	root := t.TempDir()
	cargoBin := filepath.Join(root, "cargo", "bin")
	proxy := linkRustupProxy(t, installRustup(t, cargoBin), "rust-analyzer")
	work := filepath.Join(root, "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}

	// No rust-analyzer component: the proxy only prints an error.
	if got := findBinary("rust-analyzer", "", work, []string{cargoBin}); got != "" {
		t.Fatalf("findBinary() = %q, a proxy for a tool the toolchain lacks", got)
	}
	if got := findBinary("rust-analyzer", proxy, work, nil); got != "" {
		t.Fatalf("findBinary() = %q for the user's path to such a proxy", got)
	}
	// The search goes on past it.
	elsewhere := writeExecutable(t, filepath.Join(root, "elsewhere"), "rust-analyzer")
	if got := findBinary("rust-analyzer", "", work, []string{cargoBin, filepath.Dir(elsewhere)}); got != elsewhere {
		t.Fatalf("findBinary() = %q, want %q", got, elsewhere)
	}

	// The toolchain picked in the workspace has it.
	if err := os.WriteFile(filepath.Join(work, "has-rust-analyzer"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := findBinary("rust-analyzer", "", work, []string{cargoBin}); got != proxy {
		t.Fatalf("findBinary() = %q, want the proxy %q", got, proxy)
	}
}

func TestFindBinaryDoesNotAskRustupAboutAServerOfItsOwn(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	// A rustup that would say no, beside a rust-analyzer that is not its proxy.
	installRustup(t, bin)
	server := writeExecutable(t, bin, "rust-analyzer")

	if got := findBinary("rust-analyzer", "", root, []string{bin}); got != server {
		t.Fatalf("findBinary() = %q, want %q", got, server)
	}
}

func TestSearchDirsIncludeWhereInstallersPutServers(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	t.Setenv("GOBIN", "")
	t.Setenv("GOPATH", filepath.Join(home, "gopath"))

	dirs := strings.Join(searchDirs(home, ""), "\n")
	for _, want := range []string{
		filepath.Join(home, "gopath", "bin"),
		filepath.Join(home, "go", "bin"),
		filepath.Join(home, ".cargo", "bin"),
	} {
		if !strings.Contains(dirs, want) {
			t.Fatalf("searchDirs() leaves out %q", want)
		}
	}
}

func TestFindBinaryGivesTheServerTheInstallDirectories(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("PATH", "")
	t.Setenv("GOBIN", "")
	t.Setenv("GOPATH", "")
	// No login shell to ask.
	t.Setenv("SHELL", filepath.Join(home, "no-shell"))
	gopls := writeExecutable(t, filepath.Join(home, "go", "bin"), "gopls")

	raw, err := New().FindBinary(context.Background(), mustJSON(t, FindBinaryParams{Name: "gopls"}))
	if err != nil {
		t.Fatal(err)
	}
	result := raw.(FindBinaryResult)
	if result.Path != gopls {
		t.Fatalf("FindBinary() = %q, want %q", result.Path, gopls)
	}
	envPath := filepath.SplitList(result.EnvPath)
	if envPath[0] != filepath.Dir(gopls) {
		t.Fatalf("EnvPath = %q, want the binary's directory first", result.EnvPath)
	}
	// Where rustup puts cargo, though no PATH names it.
	if !slices.Contains(envPath, filepath.Join(home, ".cargo", "bin")) {
		t.Fatalf("EnvPath = %q leaves out ~/.cargo/bin", result.EnvPath)
	}
}

func TestLoginShellPathIsAskedEachTime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no login shell")
	}
	dir := t.TempDir()
	pathFile := filepath.Join(dir, "path")
	shell := filepath.Join(dir, "sh")
	script := "#!/bin/sh\nprintf '" + loginPathMarker + "%s' \"$(cat '" + pathFile + "')\"\n"
	if err := os.WriteFile(shell, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", shell)

	for _, want := range []string{"/usr/bin:/bin", "/usr/bin:/bin:/usr/local/go/bin"} {
		// The user sets up the PATH of a tool they just installed.
		if err := os.WriteFile(pathFile, []byte(want), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := loginShellPath(); got != want {
			t.Fatalf("loginShellPath() = %q, want %q", got, want)
		}
	}
}

func TestExpandHome(t *testing.T) {
	home := filepath.Join("/", "home", "me")
	for path, want := range map[string]string{
		"~":                home,
		"~/go/bin/gopls":   filepath.Join(home, "go", "bin", "gopls"),
		"/opt/gopls":       "/opt/gopls",
		"~other/bin/gopls": "~other/bin/gopls",
		"":                 "",
	} {
		if got := expandHome(path, home); got != want {
			t.Errorf("expandHome(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestJoinPathListsKeepsEachDirectoryOnce(t *testing.T) {
	sep := string(os.PathListSeparator)
	got := joinPathLists("/a", "/b"+sep+"/a"+sep, "/c"+sep+"/b")
	if want := strings.Join([]string{"/a", "/b", "/c"}, sep); got != want {
		t.Fatalf("joinPathLists() = %q, want %q", got, want)
	}
}

func TestFindBinaryRefusesAPathForAName(t *testing.T) {
	service := New()
	if _, err := service.FindBinary(context.Background(), mustJSON(t, FindBinaryParams{Name: "../gopls"})); err == nil {
		t.Fatal("FindBinary() took a path as the command name")
	}
}
