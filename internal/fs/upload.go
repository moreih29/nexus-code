package fs

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	maxUploads     = 8
	maxUploadSize  = 20 * 1024 * 1024 * 1024
	maxUploadChunk = 512 * 1024
	uploadIdle     = 2 * time.Minute
)

var uploadIDPattern = regexp.MustCompile(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)

type uploadParams struct {
	RelPath      string `json:"relPath"`
	ExpectedPath string `json:"expectedPath"`
	Directory    bool   `json:"directory"`
	UploadID     string `json:"uploadId"`
	Size         int64  `json:"size"`
	Offset       int64  `json:"offset"`
	Data         string `json:"data"`
	SHA256       string `json:"sha256"`
}

type uploadDestination struct {
	path, parent string
	info         os.FileInfo
}

type uploadSpace struct {
	volume uint64
	free   uint64
}

type fileUpload struct {
	mu       sync.Mutex
	owner    context.Context
	ctx      context.Context
	cancel   context.CancelFunc
	stop     func() bool
	timer    *time.Timer
	deadline time.Time

	relPath  string
	dest     uploadDestination
	dir      *os.File
	file     *os.File
	temp     string
	size     int64
	received int64
	verified bool

	// Guarded by Service.uploadMu.
	space    *uploadSpace
	reserved uint64
}

func (s *Service) uploadDestination(rel string, directory bool) (uploadDestination, error) {
	var dest uploadDestination
	local := filepath.FromSlash(rel)
	if strings.ContainsRune(local, 0) || (local != "" && !filepath.IsLocal(local)) {
		return dest, FSError{Code: CodeOutOfWorkspace, Path: rel}
	}
	asked, err := s.Resolve(local)
	if err != nil {
		return dest, err
	}
	relative, err := filepath.Rel(s.root, asked)
	if err != nil {
		return dest, err
	}
	if relative == "." && !directory {
		return dest, proto.ProtocolError("the destination is a folder")
	}
	base, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return dest, mapPathError(err, s.root)
	}
	parent := base
	if relative != "." {
		parts := strings.Split(relative, string(filepath.Separator))
		for _, part := range parts[:len(parts)-1] {
			parent = filepath.Join(parent, part)
			info, err := os.Lstat(parent)
			if err != nil {
				return dest, mapPathError(err, parent)
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return dest, FSError{Code: CodeOutOfWorkspace, Path: "the path goes through a symbolic link"}
			}
			if !info.IsDir() {
				return dest, FSError{Code: CodeNotDirectory, Path: parent}
			}
		}
	}
	parent, err = filepath.EvalSymlinks(parent)
	if err != nil {
		return dest, mapPathError(err, parent)
	}
	within, err := filepath.Rel(base, parent)
	if err != nil || !filepath.IsLocal(within) {
		return dest, FSError{Code: CodeOutOfWorkspace, Path: "the path leads outside the workspace's folder"}
	}
	info, err := os.Stat(parent)
	if err != nil {
		return dest, mapPathError(err, parent)
	}
	if !info.IsDir() {
		return dest, FSError{Code: CodeNotDirectory, Path: parent}
	}
	target := parent
	if relative != "." {
		target = filepath.Join(parent, filepath.Base(asked))
	}
	return uploadDestination{path: target, parent: parent, info: info}, nil
}

func (s *Service) resolveUpload(_ context.Context, p uploadParams) (any, error) {
	dest, err := s.uploadDestination(p.RelPath, p.Directory)
	return map[string]string{"path": dest.path}, err
}

func changedUploadDestination() error {
	return FSError{Code: CodeOutOfWorkspace, Path: "the destination folder changed during the upload"}
}

func (dest uploadDestination) openParent(expected string) (*os.File, error) {
	if dest.path != expected {
		return nil, changedUploadDestination()
	}
	dir, err := openUploadParent(dest.parent)
	if err != nil {
		return nil, mapWriteError(err, dest.parent)
	}
	info, err := dir.Stat()
	if err != nil || !os.SameFile(info, dest.info) {
		_ = dir.Close()
		return nil, changedUploadDestination()
	}
	return dir, nil
}

func (s *Service) mkdirUpload(ctx context.Context, p uploadParams) (any, error) {
	dest, err := s.uploadDestination(p.RelPath, true)
	if err != nil {
		return nil, err
	}
	dir, err := dest.openParent(p.ExpectedPath)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if dest.path == dest.parent {
		return struct{}{}, nil
	}
	err = mkdirUploadAt(dir, filepath.Base(dest.path))
	if errors.Is(err, os.ErrExist) {
		_, err = uploadTarget(dest.path, true)
	}
	if err != nil {
		return nil, mapWriteError(err, dest.path)
	}
	return struct{}{}, nil
}

func uploadTarget(path string, directory bool) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) && !directory {
		return nil, nil
	}
	if err != nil {
		return nil, mapWriteError(err, path)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, FSError{Code: CodeOutOfWorkspace, Path: "the destination is a symbolic link"}
	}
	if directory && !info.IsDir() {
		return nil, proto.ProtocolError("the destination is not a folder")
	}
	if !directory && !info.Mode().IsRegular() {
		return nil, proto.ProtocolError("the destination is not a regular file")
	}
	return info, nil
}

func (s *Service) beginUpload(ctx context.Context, p uploadParams) (_ any, err error) {
	if !uploadIDPattern.MatchString(p.UploadID) || p.Size < 0 || p.Size > maxUploadSize {
		return nil, proto.ProtocolError("invalid upload ID or size")
	}
	s.uploadMu.Lock()
	if s.uploadClosed {
		s.uploadMu.Unlock()
		return nil, proto.NewError(proto.CodeUnavailable, "the filesystem agent is shutting down")
	}
	if len(s.uploads) >= maxUploads {
		s.uploadMu.Unlock()
		return nil, proto.NewError(proto.CodeUnavailable, "the host is busy writing files")
	}
	if s.uploads[p.UploadID] != nil {
		s.uploadMu.Unlock()
		return nil, proto.ProtocolError("the upload ID is already in use")
	}
	uploadCtx, cancel := context.WithCancel(ctx)
	u := &fileUpload{owner: ctx, ctx: uploadCtx, cancel: cancel, relPath: p.RelPath, size: p.Size}
	u.mu.Lock()
	s.uploads[p.UploadID] = u
	s.uploadMu.Unlock()
	defer u.mu.Unlock()
	defer func() {
		if err != nil {
			s.removeUpload(p.UploadID, u)
		}
	}()
	u.stop = context.AfterFunc(ctx, func() { s.abortPendingUpload(p.UploadID, u) })
	u.dest, err = s.uploadDestination(p.RelPath, false)
	if err != nil {
		return nil, err
	}
	u.dir, err = u.dest.openParent(p.ExpectedPath)
	if err != nil {
		return nil, err
	}
	if err = s.reserveUpload(u); err != nil {
		return nil, err
	}
	if _, err = uploadTarget(u.dest.path, false); err != nil {
		return nil, err
	}
	if err = u.ctx.Err(); err != nil {
		return nil, err
	}
	name := ".nexus-push-" + p.UploadID + ".tmp"
	u.file, err = createUploadAt(u.dir, name)
	if err != nil {
		return nil, mapWriteError(err, u.dest.path)
	}
	u.temp = name
	s.touchUpload(p.UploadID, u)
	return struct{}{}, nil
}

func (s *Service) reserveUpload(u *fileUpload) error {
	space, err := availableUploadSpace(u.dir)
	if err != nil || space == nil {
		return err
	}
	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	needed := uint64(u.size)
	for _, other := range s.uploads {
		if other.space != nil && other.space.volume == space.volume {
			needed += other.reserved
		}
	}
	if needed > space.free {
		return FSError{Code: CodeNoSpace, Path: u.dest.path}
	}
	u.space = space
	u.reserved = uint64(u.size)
	return nil
}

func (s *Service) pendingUpload(ctx context.Context, id string) *fileUpload {
	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	if u := s.uploads[id]; u != nil && u.owner == ctx {
		return u
	}
	return nil
}

// withUpload serializes disk operations for one upload. The room bounds
// parallel pieces and checks their disjoint coverage before relaying them.
func (s *Service) withUpload(ctx context.Context, id string, run func(*fileUpload) error) (any, error) {
	u := s.pendingUpload(ctx, id)
	if u == nil {
		return nil, FSError{Code: CodeNotFound, Path: "no such pending file upload"}
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if err := u.ctx.Err(); err != nil {
		return nil, err
	}
	if err := run(u); err != nil {
		s.removeUpload(id, u)
		return nil, err
	}
	return struct{}{}, nil
}

func (s *Service) chunkUpload(ctx context.Context, p uploadParams) (any, error) {
	return s.withUpload(ctx, p.UploadID, func(u *fileUpload) error {
		if u.verified || len(p.Data) > base64.StdEncoding.EncodedLen(maxUploadChunk) {
			return proto.ProtocolError("the upload is not accepting this piece")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(p.Data)
		size := int64(len(data))
		if err != nil || size == 0 || size > maxUploadChunk ||
			base64.StdEncoding.EncodeToString(data) != p.Data {
			return proto.ProtocolError("the piece has an invalid length or encoding")
		}
		if p.Offset < 0 || p.Offset > u.size-size || u.received > u.size-size {
			return proto.ProtocolError("the piece exceeds the declared file size")
		}
		if _, err := u.file.WriteAt(data, p.Offset); err != nil {
			return mapWriteError(err, u.dest.path)
		}
		u.received += size
		if u.space != nil {
			s.uploadMu.Lock()
			u.reserved -= uint64(size)
			s.uploadMu.Unlock()
		}
		s.touchUpload(p.UploadID, u)
		return nil
	})
}

// Verify before the desktop checks consent again and asks for the rename.
func (s *Service) verifyUpload(ctx context.Context, p uploadParams) (any, error) {
	return s.withUpload(ctx, p.UploadID, func(u *fileUpload) error {
		info, err := u.file.Stat()
		if err != nil {
			return err
		}
		if u.received != u.size || info.Size() != u.size {
			return proto.ProtocolError("the upload did not receive all the declared bytes")
		}
		hash := sha256.New()
		buf := make([]byte, maxUploadChunk)
		for offset := int64(0); offset < u.size; {
			if err := u.ctx.Err(); err != nil {
				return err
			}
			n, err := u.file.ReadAt(buf[:min(u.size-offset, int64(len(buf)))], offset)
			if err != nil {
				return err
			}
			_, _ = hash.Write(buf[:n])
			offset += int64(n)
		}
		if hex.EncodeToString(hash.Sum(nil)) != p.SHA256 {
			return proto.ProtocolError("the upload's SHA-256 did not match")
		}
		u.verified = true
		s.touchUpload(p.UploadID, u)
		return nil
	})
}

func (s *Service) commitUpload(ctx context.Context, p uploadParams) (any, error) {
	return s.withUpload(ctx, p.UploadID, func(u *fileUpload) error {
		if !u.verified {
			return proto.ProtocolError("the upload has not been verified")
		}
		dest, err := s.uploadDestination(u.relPath, false)
		if err != nil {
			return err
		}
		if dest.path != u.dest.path || !os.SameFile(dest.info, u.dest.info) {
			return changedUploadDestination()
		}
		existing, err := uploadTarget(dest.path, false)
		if err != nil {
			return err
		}
		if !sameUploadAt(u.dir, u.temp, u.file) {
			return FSError{Code: CodeOutOfWorkspace, Path: "the temporary file changed during the upload"}
		}
		if err := u.ctx.Err(); err != nil {
			return err
		}
		if err := publishUploadAt(u.dir, u.temp, filepath.Base(dest.path), u.file, existing); err != nil {
			return mapWriteError(err, dest.path)
		}
		u.temp = ""
		s.removeUpload(p.UploadID, u)
		return nil
	})
}

func (s *Service) touchUpload(id string, u *fileUpload) {
	u.deadline = time.Now().Add(uploadIdle)
	if u.timer == nil {
		u.timer = time.AfterFunc(uploadIdle, func() {
			u.mu.Lock()
			defer u.mu.Unlock()
			if u.ctx.Err() != nil {
				return
			}
			if remaining := time.Until(u.deadline); remaining > 0 {
				u.timer.Reset(remaining)
			} else {
				s.removeUpload(id, u)
			}
		})
	}
}

func (s *Service) removeUpload(id string, u *fileUpload) {
	u.cancel()
	if u.stop != nil {
		u.stop()
	}
	if u.timer != nil {
		u.timer.Stop()
	}
	if u.file != nil {
		if u.temp != "" && sameUploadAt(u.dir, u.temp, u.file) {
			if err := removeUploadAt(u.dir, u.temp); err != nil && !errors.Is(err, os.ErrNotExist) {
				slog.Warn("could not remove temporary upload", "path", u.dest.path, "err", err)
			}
		}
		_ = u.file.Close()
		u.file = nil
	}
	if u.dir != nil {
		_ = u.dir.Close()
		u.dir = nil
	}
	s.uploadMu.Lock()
	if s.uploads[id] == u {
		delete(s.uploads, id)
	}
	s.uploadMu.Unlock()
}

func (s *Service) abortPendingUpload(id string, u *fileUpload) {
	u.cancel()
	u.mu.Lock()
	defer u.mu.Unlock()
	s.removeUpload(id, u)
}

func (s *Service) abortUpload(ctx context.Context, p uploadParams) (any, error) {
	if u := s.pendingUpload(ctx, p.UploadID); u != nil {
		s.abortPendingUpload(p.UploadID, u)
	}
	return struct{}{}, nil
}

// DropUploads drains uploads owned by a closed connection, or all uploads
// when the service shuts down. Daemon reattach keeps the other services alive.
func (s *Service) DropUploads(owner context.Context) {
	s.uploadMu.Lock()
	if owner == nil {
		s.uploadClosed = true
	}
	pending := make(map[string]*fileUpload)
	for id, u := range s.uploads {
		if owner == nil || u.owner == owner {
			u.cancel()
			pending[id] = u
		}
	}
	s.uploadMu.Unlock()
	for id, u := range pending {
		s.abortPendingUpload(id, u)
	}
}

func bindUpload(handler func(context.Context, uploadParams) (any, error)) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p uploadParams
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, proto.ProtocolError("invalid upload parameters")
		}
		return handler(ctx, p)
	}
}
