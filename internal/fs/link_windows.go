//go:build windows

package fs

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"unicode/utf16"

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
	return createJunction(dst, filepath.Clean(target))
}

// createJunction makes link a junction to the directory at the absolute path
// target.
func createJunction(link, target string) error {
	if err := os.Mkdir(link, 0o755); err != nil {
		return err
	}
	if err := setMountPoint(link, target); err != nil {
		_ = os.Remove(link)
		return err
	}
	return nil
}

// setMountPoint turns the empty directory dir into a junction to target.
func setMountPoint(dir, target string) error {
	path, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(path, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)

	buf := mountPointReparseData(target)
	var returned uint32
	return windows.DeviceIoControl(h, windows.FSCTL_SET_REPARSE_POINT, &buf[0], uint32(len(buf)), nil, 0, &returned, nil)
}

// mountPointReparseData lays out a REPARSE_DATA_BUFFER for a junction to
// target: the NT path it leads to (\??\C:\...) and the path shown for it, each
// ending in NUL.
func mountPointReparseData(target string) []byte {
	substitute := utf16.Encode([]rune(`\??\` + target))
	shown := utf16.Encode([]rune(target))
	names := append(append(append(substitute, 0), shown...), 0)

	dataLen := 8 + 2*len(names)
	buf := make([]byte, 8+dataLen)
	binary.LittleEndian.PutUint32(buf[0:], windows.IO_REPARSE_TAG_MOUNT_POINT)
	binary.LittleEndian.PutUint16(buf[4:], uint16(dataLen))
	binary.LittleEndian.PutUint16(buf[8:], 0)                            // SubstituteNameOffset
	binary.LittleEndian.PutUint16(buf[10:], uint16(2*len(substitute)))   // SubstituteNameLength
	binary.LittleEndian.PutUint16(buf[12:], uint16(2*len(substitute)+2)) // PrintNameOffset
	binary.LittleEndian.PutUint16(buf[14:], uint16(2*len(shown)))        // PrintNameLength
	for i, c := range names {
		binary.LittleEndian.PutUint16(buf[16+2*i:], c)
	}
	return buf
}
