//go:build windows

package fs

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/nexus-code/nexus-code/internal/filelink"

	"golang.org/x/sys/windows"
)

// symlinkFallback stands in for the symbolic link at src, to target, that
// could not be created at dst. Windows lets only an administrator, or a PC in
// Developer Mode, create one, so copying a folder with a link in it, such as
// a junction pnpm puts in node_modules, failed. A link to a directory becomes
// a junction to it, which needs no privilege; a link to a file becomes a copy
// of the file. A relative target leads where the copied link would.
func symlinkFallback(src, dst, target string, err error) error {
	if !errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD) {
		return err
	}
	info, statErr := os.Stat(src)
	if statErr != nil {
		// A dangling link leads nowhere to stand in for.
		return err
	}
	if !info.IsDir() {
		return copyFileContents(src, dst, info)
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(dst), target)
	}
	return filelink.Junction(dst, filepath.Clean(target))
}
