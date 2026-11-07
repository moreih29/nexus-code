package hookclient

import (
	"path/filepath"
	"regexp"
	"strings"
)

// A node package's command, as npm and pnpm install it on Windows: an sh
// script for Git Bash and a .cmd for cmd.exe, each running node on the
// package's script.
var (
	// shNodeShim is the sh script's line that runs node on the script.
	shNodeShim = regexp.MustCompile(`(?m)^[ \t]*exec node[ \t]+([^"\n]*?)[ \t]*"\$basedir/([^"\n]+)"[ \t]+"\$@"[ \t]*$`)
	// cmdNodeShim is the .cmd's: `_prog` is node, set where the script was
	// found to be a node one.
	cmdNodeShim = regexp.MustCompile(`(?m)"%_prog%"[ \t]+([^"\r\n]*?)[ \t]*"%dp0%\\([^"\r\n]+)"[ \t]+%\*[ \t]*\r?$`)
	cmdNodeProg = regexp.MustCompile(`(?m)SET "_prog=%dp0%\\node\.exe"`)
)

// nodeShimOf reads `content` as the node shim at `path`: the script node
// runs, and node's own options. False when it is none.
func nodeShimOf(path string, content []byte) (script string, nodeArgs []string, ok bool) {
	text := string(content)
	var m []string
	switch strings.ToLower(filepath.Ext(path)) {
	case ".cmd", ".bat":
		if cmdNodeProg.MatchString(text) {
			m = cmdNodeShim.FindStringSubmatch(text)
		}
	case "":
		if strings.HasPrefix(text, "#!/bin/sh") {
			m = shNodeShim.FindStringSubmatch(text)
		}
	}
	if m == nil {
		return "", nil, false
	}
	// Options that are plain words; anything quoted or expanded is the
	// shell's to read.
	nodeArgs = strings.Fields(m[1])
	for _, arg := range nodeArgs {
		if strings.ContainsAny(arg, `"'$%`+"`") {
			return "", nil, false
		}
	}
	rel := strings.ReplaceAll(m[2], `\`, "/")
	return filepath.Join(filepath.Dir(path), filepath.FromSlash(rel)), nodeArgs, true
}
