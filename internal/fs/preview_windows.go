package fs

import (
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func openPreviewFile(real string) (*os.File, error) {
	return openCanonicalPath(real, false)
}

func openProtectedDirectory(real string) (*os.File, error) {
	return openCanonicalPath(real, true)
}

func openCanonicalPath(real string, directory bool) (*os.File, error) {
	volume := filepath.VolumeName(real)
	root, err := windows.UTF16PtrFromString(volume + `\`)
	if err != nil {
		return nil, err
	}
	const share = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE
	access := uint32(windows.FILE_TRAVERSE | windows.FILE_READ_ATTRIBUTES)
	if directory && filepath.Clean(real) == volume+`\` {
		access = windows.FILE_GENERIC_READ
	}
	handle, err := windows.CreateFile(root, access, share,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return nil, err
	}
	relative := strings.TrimPrefix(real[len(volume):], `\`)
	if relative == "" && directory {
		return os.NewFile(uintptr(handle), real), nil
	}
	parts := strings.Split(relative, `\`)
	for i, part := range parts {
		var next windows.Handle
		if i == len(parts)-1 {
			flags := uint32(0)
			if directory {
				flags = windows.FILE_DIRECTORY_FILE
			}
			next, err = previewOpenAt(handle, part, windows.FILE_GENERIC_READ, share, flags)
		} else {
			next, err = previewOpenAt(handle, part, windows.FILE_TRAVERSE|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE, share, windows.FILE_DIRECTORY_FILE)
		}
		windows.CloseHandle(handle)
		if status, ok := err.(windows.NTStatus); ok {
			if status == windows.STATUS_REPARSE_POINT_ENCOUNTERED {
				err = FSError{Code: CodeOutOfWorkspace, Path: real}
			} else {
				err = status.Errno()
			}
		}
		if err != nil {
			return nil, err
		}
		handle = next
	}
	return os.NewFile(uintptr(handle), real), nil
}

func previewOpenAt(parent windows.Handle, name string, access, share, flags uint32) (windows.Handle, error) {
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return 0, err
	}
	attrs := windows.OBJECT_ATTRIBUTES{
		RootDirectory: parent,
		ObjectName:    objectName,
		Attributes:    windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE,
	}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var child windows.Handle
	err = windows.NtCreateFile(&child, access, &attrs, &windows.IO_STATUS_BLOCK{}, nil,
		0, share, windows.FILE_OPEN, flags|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
	return child, err
}

func previewFileStamp(file *os.File, info os.FileInfo, versioned bool) (previewStamp, bool) {
	handle := windows.Handle(file.Fd())
	var basic struct {
		created, accessed, modified, changed int64
		attributes                           uint32
		_                                    uint32
	}
	var identity windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &identity) != nil ||
		windows.GetFileInformationByHandleEx(handle, windows.FileBasicInfo,
			(*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))) != nil {
		return previewStamp{}, false
	}
	stamp := previewStamp{uint64(identity.VolumeSerialNumber),
		uint64(identity.FileIndexHigh)<<32 | uint64(identity.FileIndexLow), basic.changed}
	if !versioned || stamp.inode == 0 {
		return stamp, false
	}
	root, err := windows.UTF16PtrFromString(filepath.VolumeName(file.Name()) + `\`)
	var volume [16]uint16
	return stamp, err == nil && windows.GetDriveType(root) == windows.DRIVE_FIXED &&
		windows.GetVolumeInformationByHandle(handle, nil, 0, nil, nil, nil, &volume[0], uint32(len(volume))) == nil &&
		windows.UTF16ToString(volume[:]) == "NTFS"
}

func protectedEntrySize(dir *os.File, name string) *int64 {
	handle, err := previewOpenAt(windows.Handle(dir.Fd()), name, windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_NON_DIRECTORY_FILE)
	if err != nil {
		return nil
	}
	file := os.NewFile(uintptr(handle), name)
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	size := info.Size()
	return &size
}
