package nodeshim

import (
	"path/filepath"
	"strings"
	"testing"
)

// npmShim is the sh script npm installs for a node package's command.
const npmShim = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")

case ` + "`uname`" + ` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=` + "`cygpath -w \"$basedir\"`" + `
        fi
    ;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"
else
  exec node  "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"
fi
`

// npmCmdShim is the .cmd npm installs beside it.
const npmCmdShim = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n" +
	"IF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n" +
	"endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n"

// pnpmShim is pnpm's, which tells node where its packages are.
const pnpmShim = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")

case ` + "`uname`" + ` in
    *CYGWIN*) basedir=` + "`cygpath -w \"$basedir\"`" + `;;
esac

if [ -z "$NODE_PATH" ]; then
  export NODE_PATH="/home/u/.local/share/pnpm/global/5/node_modules"
else
  export NODE_PATH="/home/u/.local/share/pnpm/global/5/node_modules:$NODE_PATH"
fi
if [ -x "$basedir/node" ]; then
  exec "$basedir/node" --no-warnings "$basedir/global/5/node_modules/@anthropic-ai/claude-code/cli.js" "$@"
else
  exec node --no-warnings "$basedir/global/5/node_modules/@anthropic-ai/claude-code/cli.js" "$@"
fi
`

func TestShimOf(t *testing.T) {
	dir := filepath.Join("C:", "npm")
	codexJS := filepath.Join(dir, "node_modules", "@openai", "codex", "bin", "codex.js")
	for _, tc := range []struct {
		name, path, content string
		script              string
		nodeArgs            []string
	}{
		{name: "npm's sh script", path: filepath.Join(dir, "codex"), content: npmShim, script: codexJS},
		{name: "npm's .cmd", path: filepath.Join(dir, "codex.cmd"), content: npmCmdShim, script: codexJS},
		{
			name: "pnpm's, with node's options", path: filepath.Join(dir, "claude"), content: pnpmShim,
			script:   filepath.Join(dir, "global", "5", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
			nodeArgs: []string{"--no-warnings"},
		},
		{name: "a script of another program", path: filepath.Join(dir, "codex"),
			content: "#!/bin/sh\nexec \"$basedir/sh\" \"$basedir/codex.sh\" \"$@\"\n"},
		{name: "node's options the shell reads", path: filepath.Join(dir, "codex"),
			content: "#!/bin/sh\nexec node $OPTS \"$basedir/codex.js\" \"$@\"\n"},
		{name: "the sh script read as a .cmd", path: filepath.Join(dir, "codex.cmd"), content: npmShim},
		{name: "a .cmd whose program is not node", path: filepath.Join(dir, "codex.cmd"),
			content: "\"%_prog%\"  \"%dp0%\\codex.py\" %*\r\n"},
		{name: "a program", path: filepath.Join(dir, "codex.exe"), content: "MZ"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			script, nodeArgs, ok := shimOf(tc.path, []byte(tc.content))
			if ok != (tc.script != "") || script != tc.script ||
				strings.Join(nodeArgs, " ") != strings.Join(tc.nodeArgs, " ") {
				t.Fatalf("shimOf = %q, %q, %v", script, nodeArgs, ok)
			}
		})
	}
}
