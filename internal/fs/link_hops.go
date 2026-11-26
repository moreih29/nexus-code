package fs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const maxLinkHops = 40

var errTooManyLinks = errors.New("too many links")

func isNetworkTarget(path string) bool {
	if runtime.GOOS == "windows" {
		kind := classifyWindowsPath(path)
		return kind == windowsUNCPath || kind == windowsDevicePath
	}
	return isAutoMountTarget(path)
}

func isAutoMountTarget(path string) bool {
	if !strings.HasPrefix(path, "/") {
		return false
	}
	var parts []string
	for _, part := range strings.Split(path, "/") {
		switch part {
		case "", ".":
		case "..":
			if len(parts) > 0 {
				parts = parts[:len(parts)-1]
			}
		default:
			parts = append(parts, strings.ToLower(part))
		}
	}
	top := 0
	if len(parts) >= 3 && parts[0] == "system" && parts[1] == "volumes" && parts[2] == "data" {
		top = 3
	}
	return len(parts) > top && (parts[top] == "net" || parts[top] == "network")
}

func linkTarget(link, raw string) string {
	if runtime.GOOS == "windows" {
		if rest, ok := strings.CutPrefix(raw, `\??\`); ok && classifyWindowsPath(rest) == windowsDrivePath {
			raw = rest
		}
		if rest, ok := strings.CutPrefix(raw, `\\?\`); ok && classifyWindowsPath(rest) == windowsDrivePath {
			raw = rest
		}
	}
	if filepath.IsAbs(raw) || isNetworkTarget(raw) {
		return filepath.Clean(raw)
	}
	return filepath.Join(filepath.Dir(link), raw)
}

func isLinkMode(mode fs.FileMode) bool {
	return mode&fs.ModeSymlink != 0 || runtime.GOOS == "windows" && mode&fs.ModeIrregular != 0
}

func networkHop(abs string) (string, error) {
	if isNetworkTarget(abs) {
		return "", nil
	}
	volume := filepath.VolumeName(abs)
	current := volume + string(filepath.Separator)
	pending := splitPathParts(abs[len(volume):])
	hops := 0
	for len(pending) > 0 {
		part := pending[0]
		pending = pending[1:]
		if part == "." {
			continue
		}
		if part == ".." {
			current = filepath.Dir(current)
			continue
		}
		next := filepath.Join(current, part)
		info, err := os.Lstat(next)
		if err != nil {
			return "", nil
		}
		if !isLinkMode(info.Mode()) {
			current = next
			continue
		}
		raw, err := os.Readlink(next)
		if err != nil {
			current = next
			continue
		}
		hops++
		if hops > maxLinkHops {
			return "", errTooManyLinks
		}
		target := linkTarget(next, raw)
		if isNetworkTarget(target) {
			return target, nil
		}
		volume = filepath.VolumeName(target)
		current = volume + string(filepath.Separator)
		pending = append(splitPathParts(target[len(volume):]), pending...)
	}
	return "", nil
}

func splitPathParts(rest string) []string {
	var parts []string
	for _, part := range strings.FieldsFunc(rest, func(r rune) bool {
		return r == '/' || r == filepath.Separator
	}) {
		parts = append(parts, part)
	}
	return parts
}

func refuseNetworkHop(abs string) error {
	if target, err := networkHop(abs); err != nil || target != "" {
		return FSError{Code: CodeOutOfWorkspace, Path: abs}
	}
	return nil
}
