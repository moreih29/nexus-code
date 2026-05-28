package fs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	iofs "io/fs"
	"os"
	"path/filepath"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// CopyFile implements fs.copyFile with O_EXCL semantics: the source must exist
// and the destination must not. Regular files, directories (recursive), and
// symlinks (link preserved) are all supported.
func (s *Service) CopyFile(ctx context.Context, raw json.RawMessage) (any, error) {
	var p CopyFileParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, proto.ProtocolError("fs.copyFile params must include fromRelPath and toRelPath")
	}
	if p.FromRelPath == "" || p.ToRelPath == "" {
		return nil, proto.ProtocolError("fs.copyFile fromRelPath and toRelPath are required")
	}

	srcAbs, err := s.Resolve(p.FromRelPath)
	if err != nil {
		return nil, err
	}
	dstAbs, err := s.Resolve(p.ToRelPath)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Source must exist.
	srcInfo, err := os.Lstat(srcAbs)
	if err != nil {
		return nil, mapWriteError(err, srcAbs)
	}

	// Destination existence check. By default the destination must NOT exist
	// (O_EXCL semantics). With Overwrite=true the caller has confirmed a
	// replace, so an existing destination is removed first.
	if _, err := os.Lstat(dstAbs); err == nil {
		if !p.Overwrite {
			return nil, FSError{Code: CodeAlreadyExists, Path: dstAbs}
		}
		if err := os.RemoveAll(dstAbs); err != nil {
			return nil, mapWriteError(err, dstAbs)
		}
	} else if !errors.Is(err, iofs.ErrNotExist) {
		return nil, mapWriteError(err, dstAbs)
	}

	if srcInfo.IsDir() {
		if err := copyDir(srcAbs, dstAbs); err != nil {
			return nil, mapWriteError(err, srcAbs)
		}
	} else if srcInfo.Mode()&os.ModeSymlink != 0 {
		if err := copySymlink(srcAbs, dstAbs); err != nil {
			return nil, mapWriteError(err, srcAbs)
		}
	} else {
		if err := copyRegularFile(srcAbs, dstAbs, srcInfo); err != nil {
			return nil, mapWriteError(err, srcAbs)
		}
	}

	return struct{}{}, nil
}

// copyRegularFile copies the bytes and permission bits of a regular file.
func copyRegularFile(src, dst string, srcInfo os.FileInfo) error {
	return copyFileContents(src, dst, srcInfo)
}

// copyDir creates the destination directory and recursively copies every entry.
func copyDir(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}
	if err := os.Mkdir(dst, srcInfo.Mode()); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		srcEntry := filepath.Join(src, entry.Name())
		dstEntry := filepath.Join(dst, entry.Name())

		info, err := os.Lstat(srcEntry)
		if err != nil {
			return err
		}
		if info.IsDir() {
			if err := copyDir(srcEntry, dstEntry); err != nil {
				return err
			}
		} else if info.Mode()&os.ModeSymlink != 0 {
			if err := copySymlink(srcEntry, dstEntry); err != nil {
				return err
			}
		} else {
			if err := copyRegularFile(srcEntry, dstEntry, info); err != nil {
				return err
			}
		}
	}
	return nil
}

// copySymlink preserves the symlink by reading the link target and creating
// a new symlink at the destination with the same target.
func copySymlink(src, dst string) error {
	target, err := os.Readlink(src)
	if err != nil {
		return err
	}
	return os.Symlink(target, dst)
}

// copyFileContents is the single io.Copy path used by copyRegularFile.
func copyFileContents(src, dst string, srcInfo os.FileInfo) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, srcInfo.Mode())
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}
