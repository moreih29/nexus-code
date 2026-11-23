package fs

import (
	"path/filepath"
	"sync"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/filewatch"
)

const MaxReadableFileSize = 50 * 1024 * 1024

const MaxReadRangeLength = 1024 * 1024

type EventSink func(event string, payload any) error

type Service struct {
	root          string
	protectedRoot string

	uploadMu     sync.Mutex
	uploads      map[string]*fileUpload
	uploadClosed bool

	watchMu sync.Mutex
	shared  *watchEntry

	mu      sync.Mutex
	watches map[string]*watchEntry
	buffers map[string]filewatch.FsChangeKind
	timer   *time.Timer
	sink    EventSink
}

func New(root string) (*Service, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	abs = filepath.Clean(abs)
	protectedRoot, err := filepath.EvalSymlinks(abs)
	if err != nil {
		protectedRoot = abs
	}
	return &Service{
		root:          abs,
		protectedRoot: protectedRoot,
		uploads:       make(map[string]*fileUpload),
		watches:       make(map[string]*watchEntry),
		buffers:       make(map[string]filewatch.FsChangeKind),
	}, nil
}

func (s *Service) SetEventSink(sink EventSink) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sink = sink
}

func (s *Service) Close() {
	s.DropUploads(nil)
	s.watchMu.Lock()
	defer s.watchMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	for abs, entry := range s.watches {
		entry.close()
		delete(s.watches, abs)
	}
	if s.shared != nil {
		s.shared.close()
		s.shared = nil
	}
	clear(s.buffers)
}

func Register(d *dispatch.Dispatcher, fsys *Service) {
	d.Register("fs.readdir", fsys.Readdir)
	d.Register("fs.readdirNoLinks", fsys.ReaddirNoLinks)
	d.Register("fs.readFileNoLinks", fsys.ReadFileNoLinks)
	d.Register("fs.readRangeNoLinks", fsys.ReadRangeNoLinks)
	d.Register("fs.stat", fsys.Stat)
	d.Register("fs.readFile", fsys.ReadFile)
	d.Register("fs.readBinary", fsys.ReadBinary)
	d.Register("fs.readAbsolute", fsys.ReadAbsolute)
	d.Register("fs.readAbsoluteBinary", fsys.ReadAbsoluteBinary)
	d.Register("fs.readRange", fsys.ReadRange)
	d.Register("fs.readAbsoluteRange", fsys.ReadAbsoluteRange)
	d.Register("fs.readPreview", fsys.ReadPreview)
	d.Register("fs.writeFile", fsys.WriteFile)
	d.Register("fs.upload.resolve", bindUpload(fsys.resolveUpload))
	d.Register("fs.upload.mkdir", bindUpload(fsys.mkdirUpload))
	d.Register("fs.upload.begin", bindUpload(fsys.beginUpload))
	d.Register("fs.upload.chunk", bindUpload(fsys.chunkUpload))
	d.Register("fs.upload.verify", bindUpload(fsys.verifyUpload))
	d.Register("fs.upload.commit", bindUpload(fsys.commitUpload))
	d.Register("fs.upload.abort", bindUpload(fsys.abortUpload))
	d.Register("fs.createFile", fsys.CreateFile)
	d.Register("fs.mkdir", fsys.Mkdir)
	d.Register("fs.unlink", fsys.Unlink)
	d.Register("fs.rmdir", fsys.Rmdir)
	d.Register("fs.rename", fsys.Rename)
	d.Register("fs.copyFile", fsys.CopyFile)
	d.Register("fs.removeAll", fsys.RemoveAll)
	d.RegisterOrderedBy("fs.watch", fsys.Watch, fsys.watchOrderKey)
	d.RegisterOrderedBy("fs.unwatch", fsys.Unwatch, fsys.watchOrderKey)
}
