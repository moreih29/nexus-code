package nodeshim

import (
	"path/filepath"
	"regexp"
	"strings"
)

var (
	shNodeShim  = regexp.MustCompile(`(?m)^[ \t]*exec node[ \t]+([^"\n]*?)[ \t]*"\$basedir/([^"\n]+)"[ \t]+"\$@"[ \t]*$`)
	cmdNodeShim = regexp.MustCompile(`(?m)"%_prog%"[ \t]+([^"\r\n]*?)[ \t]*"%dp0%\\([^"\r\n]+)"[ \t]+%\*[ \t]*\r?$`)
	cmdNodeProg = regexp.MustCompile(`(?m)SET "_prog=%dp0%\\node\.exe"`)
)

func shimOf(path string, content []byte) (script string, nodeArgs []string, ok bool) {
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
	nodeArgs = strings.Fields(m[1])
	for _, arg := range nodeArgs {
		if strings.ContainsAny(arg, `"'$%`+"`") {
			return "", nil, false
		}
	}
	rel := strings.ReplaceAll(m[2], `\`, "/")
	return filepath.Join(filepath.Dir(path), filepath.FromSlash(rel)), nodeArgs, true
}
