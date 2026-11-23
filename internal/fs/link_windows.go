//go:build windows

package fs

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"github.com/nexus-code/nexus-code/internal/filelink"

	"golang.org/x/sys/windows"
)

func symlinkFallback(ctx context.Context, src, dst, target string, err error) (bool, error) {
	if !errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD) {
		return false, err
	}
	info, statErr := os.Stat(src)
	if statErr != nil {
		return false, err
	}
	if !info.IsDir() {
		return copyFileContents(ctx, src, dst, info)
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(dst), target)
	}
	err = filelink.Junction(dst, filepath.Clean(target))
	return err == nil, err
}
