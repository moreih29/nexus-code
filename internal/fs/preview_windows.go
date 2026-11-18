package fs

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func openPreviewFile(real string, versioned bool) (*os.File, bool, error) {
	volume := filepath.VolumeName(real)
	root, err := windows.UTF16PtrFromString(volume + `\`)
	if err != nil {
		return nil, false, err
	}
	const share = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE
	handle, err := windows.CreateFile(root, windows.FILE_TRAVERSE|windows.FILE_READ_ATTRIBUTES, share,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return nil, false, err
	}
	// Network filesystems and removable media can report stale or coarse timestamps.
	versioned = versioned && windows.GetDriveType(root) == windows.DRIVE_FIXED
	parts := strings.Split(strings.TrimPrefix(real[len(volume):], `\`), `\`)
	for i, part := range parts {
		var next windows.Handle
		if i == len(parts)-1 {
			// NTFS may delay updating timestamps while a writer has the file open.
			// A handle that excludes writers can validate; otherwise read fresh.
			if versioned {
				next, err = previewOpenAt(handle, part, windows.FILE_GENERIC_READ, share&^windows.FILE_SHARE_WRITE, 0)
				if errors.Is(err, windows.STATUS_SHARING_VIOLATION) {
					versioned = false
				}
			}
			if !versioned {
				next, err = previewOpenAt(handle, part, windows.FILE_GENERIC_READ, share, 0)
			}
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
			return nil, false, err
		}
		handle = next
	}
	return os.NewFile(uintptr(handle), real), versioned, nil
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
	var volume [16]uint16
	return stamp, versioned && stamp.change > 0 && stamp.inode != 0 &&
		windows.GetVolumeInformationByHandle(handle, nil, 0, nil, nil, nil, &volume[0], uint32(len(volume))) == nil &&
		windows.UTF16ToString(volume[:]) == "NTFS"
}
