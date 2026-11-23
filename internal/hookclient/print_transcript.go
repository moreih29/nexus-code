package hookclient

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/nexus-code/nexus-code/internal/claudefiles"
)

var printTranscriptPoll = 200 * time.Millisecond

type printTranscript struct {
	config     string
	sessionID  string
	from       int64
	stop, done chan struct{}
}

func newPrintTranscript(sessionID string) *printTranscript {
	dir := claudeConfigDir()
	if dir == "" {
		return nil
	}
	return &printTranscript{
		config:    dir,
		sessionID: sessionID,
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
}

func claudeConfigDir() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude")
}

func absoluteDir(dir string) string {
	if dir == "" {
		return ""
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return ""
	}
	return abs
}

func (tr *printTranscript) follow(watch *printWatch, found func()) {
	followFile(tr.open, tr.from, watch.line, found, tr.stop, tr.done)
}

func followFile(
	open func() *os.File,
	from int64,
	line func([]byte),
	found func(),
	stop <-chan struct{},
	done chan<- struct{},
) {
	defer close(done)
	ticker := time.NewTicker(printTranscriptPoll)
	defer ticker.Stop()
	var file *os.File
	defer func() {
		if file != nil {
			file.Close()
		}
	}()
	lines := lineSplitter{line: line}
	buf := make([]byte, 64<<10)
	for {
		ended := false
		select {
		case <-stop:
			ended = true
		case <-ticker.C:
		}
		if file == nil {
			if file = open(); file != nil {
				if from > 0 {
					_, _ = file.Seek(from, io.SeekStart)
				}
				found()
			}
		}
		for file != nil {
			n, err := file.Read(buf)
			lines.feed(buf[:n])
			if err != nil || n == 0 {
				break
			}
		}
		if ended {
			lines.flush()
			return
		}
	}
}

func (tr *printTranscript) open() *os.File {
	path, info := claudefiles.FindSession(tr.config, tr.sessionID)
	if path == "" {
		return nil
	}
	file, _, err := claudefiles.Open(path, info)
	if err != nil {
		return nil
	}
	return file
}

func (tr *printTranscript) startAtEnd() {
	file := tr.open()
	if file == nil {
		return
	}
	defer file.Close()
	if info, err := file.Stat(); err == nil {
		tr.from = info.Size()
	}
}

func (tr *printTranscript) end(wait time.Duration) bool {
	close(tr.stop)
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-tr.done:
		return true
	case <-timer.C:
		return false
	}
}

func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
