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

	// Keep the old destination until the replacement has fully succeeded.
	backup := ""
	if _, err := os.Lstat(dstAbs); err == nil {
		if !p.Overwrite {
			return nil, FSError{Code: CodeAlreadyExists, Path: dstAbs}
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if backup, err = moveAside(dstAbs); err != nil {
			return nil, mapWriteError(err, dstAbs)
		}
	} else if !errors.Is(err, iofs.ErrNotExist) {
		return nil, mapWriteError(err, dstAbs)
	}

	created, err := copyPath(ctx, srcAbs, dstAbs, srcInfo)
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		if rollbackErr := rollbackCopy(dstAbs, backup, created); rollbackErr != nil {
			return nil, errors.Join(mapWriteError(err, srcAbs), rollbackErr)
		}
		return nil, mapWriteError(err, srcAbs)
	}
	if err := discardAside(backup); err != nil {
		return nil, mapWriteError(err, backup)
	}

	return struct{}{}, nil
}

// rollbackCopy removes only the path created by this copy. A destination
// that appeared before creation succeeded belongs to another operation.
func rollbackCopy(dst, backup string, created bool) error {
	if created {
		if err := os.RemoveAll(dst); err != nil {
			return err
		}
	}
	if backup == "" {
		return nil
	}
	if _, err := os.Lstat(dst); err == nil {
		return FSError{Code: CodeAlreadyExists, Path: dst}
	} else if !errors.Is(err, iofs.ErrNotExist) {
		return err
	}
	return os.Rename(backup, dst)
}

// copyPath reports whether this operation owns the destination, including
// on error, so a failed attempt can remove its partial copy safely.
func copyPath(ctx context.Context, src, dst string, info os.FileInfo) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	switch {
	case info.IsDir():
		if err := os.Mkdir(dst, info.Mode()); err != nil {
			return false, err
		}
		return true, copyDirEntries(ctx, src, dst)
	case info.Mode()&os.ModeSymlink != 0:
		return copySymlink(ctx, src, dst)
	case info.Mode().IsRegular():
		return copyFileContents(ctx, src, dst, info)
	default:
		return false, proto.ProtocolError("fs.copyFile source must be a regular file, directory, or symlink")
	}
}

// copyDirEntries copies each child into the directory owned by this copy.
func copyDirEntries(ctx context.Context, src, dst string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		srcEntry := filepath.Join(src, entry.Name())
		info, err := os.Lstat(srcEntry)
		if err != nil {
			return err
		}
		if _, err := copyPath(ctx, srcEntry, filepath.Join(dst, entry.Name()), info); err != nil {
			return err
		}
	}
	return nil
}

// copySymlink preserves the original link target or uses the platform fallback.
func copySymlink(ctx context.Context, src, dst string) (bool, error) {
	target, err := os.Readlink(src)
	if err != nil {
		return false, err
	}
	if err := os.Symlink(target, dst); err != nil {
		return symlinkFallback(ctx, src, dst, target, err)
	}
	return true, nil
}

// copyFileContents keeps the permission bits and checks cancellation
// between chunks. Wrapping the reader avoids an uncancellable file fast path.
func copyFileContents(ctx context.Context, src, dst string, srcInfo os.FileInfo) (bool, error) {
	in, err := os.Open(src)
	if err != nil {
		return false, err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, srcInfo.Mode())
	if err != nil {
		return false, err
	}
	defer out.Close()

	if _, err := io.Copy(out, copyReader{ctx, in}); err != nil {
		return true, err
	}
	if err := ctx.Err(); err != nil {
		return true, err
	}
	if err := out.Sync(); err != nil {
		return true, err
	}
	return true, out.Close()
}

type copyReader struct {
	ctx context.Context
	src io.Reader
}

// Read checks cancellation before io.Copy reads the next block.
func (r copyReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.src.Read(p)
}
