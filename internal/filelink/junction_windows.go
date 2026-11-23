//go:build windows

package filelink

import (
	"encoding/binary"
	"os"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

func Junction(link, target string) error {
	if err := os.Mkdir(link, 0o755); err != nil {
		return err
	}
	if err := setMountPoint(link, target); err != nil {
		_ = os.Remove(link)
		return err
	}
	return nil
}

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

func mountPointReparseData(target string) []byte {
	substitute := utf16.Encode([]rune(`\??\` + target))
	shown := utf16.Encode([]rune(target))
	names := append(append(append(substitute, 0), shown...), 0)

	dataLen := 8 + 2*len(names)
	buf := make([]byte, 8+dataLen)
	binary.LittleEndian.PutUint32(buf[0:], windows.IO_REPARSE_TAG_MOUNT_POINT)
	binary.LittleEndian.PutUint16(buf[4:], uint16(dataLen))
	binary.LittleEndian.PutUint16(buf[8:], 0)
	binary.LittleEndian.PutUint16(buf[10:], uint16(2*len(substitute)))
	binary.LittleEndian.PutUint16(buf[12:], uint16(2*len(substitute)+2))
	binary.LittleEndian.PutUint16(buf[14:], uint16(2*len(shown)))
	for i, c := range names {
		binary.LittleEndian.PutUint16(buf[16+2*i:], c)
	}
	return buf
}
