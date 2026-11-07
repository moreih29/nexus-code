//go:build windows

package hookclient

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// npmInstall writes a node package's command as npm installs it in a
// directory of its own; the script prints its arguments as JSON.
func npmInstall(t *testing.T) (dir, script string) {
	t.Helper()
	dir = t.TempDir()
	script = filepath.Join(dir, "node_modules", "@openai", "codex", "bin", "codex.js")
	if err := os.MkdirAll(filepath.Dir(script), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		script:                          "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n",
		filepath.Join(dir, "codex"):     npmShim,
		filepath.Join(dir, "codex.cmd"): npmCmdShim,
		filepath.Join(dir, "codex.ps1"): "#!/usr/bin/env pwsh\n",
	} {
		if err := os.WriteFile(name, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir, script
}

func TestProgramCommand_RunsANodeShimAsNodeOnItsScript(t *testing.T) {
	dir, script := npmInstall(t)
	node := filepath.Join(dir, "node.exe")
	if err := os.WriteFile(node, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		filepath.Join(dir, "codex"),
		// As Git Bash passes it.
		filepath.ToSlash(filepath.Join(dir, "codex")),
		filepath.Join(dir, "codex.cmd"),
	} {
		cmd := programCommand(path, "exec", "hi")
		if cmd.Path != node || !reflect.DeepEqual(cmd.Args[1:], []string{script, "exec", "hi"}) {
			t.Fatalf("%s runs %q %q", path, cmd.Path, cmd.Args)
		}
	}
}

func TestProgramCommand_LeavesAnyOtherProgram(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "codex.exe"), []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "codex")
	cmd := programCommand(path, "exec")
	if want := exec.Command(path, "exec"); cmd.Path != want.Path || !reflect.DeepEqual(cmd.Args, want.Args) {
		t.Fatalf("runs %q %q", cmd.Path, cmd.Args)
	}
}

func TestProgramCommand_PassesTheArgumentsAsTheyAre(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node on PATH")
	}
	dir, _ := npmInstall(t)
	args := []string{
		"exec", "Fix the test.\nThen run it.", "don't", `say "hi"`, "%USERPROFILE%", "$HOME",
		`C:\dir with space\`, "", "a & b | c", "한글",
	}
	var out bytes.Buffer
	cmd := programCommand(filepath.Join(dir, "codex"), args...)
	cmd.Stdout = &out
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := json.Unmarshal(out.Bytes(), &got); err != nil || !reflect.DeepEqual(got, args) {
		t.Fatalf("the script got %q (%v)", strings.TrimSpace(out.String()), err)
	}
}
