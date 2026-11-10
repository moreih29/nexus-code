package hookclient

// A `claude -p` run whose output does not tell its tools, in text or json,
// tells them in its transcript: Claude Code writes each message of the run
// as it goes, `--bare` or not, to <config>/projects/<project>/<session
// id>.jsonl, a line each, in the shape stream-json prints them. print-run
// gives such a run a session id, unless it has one, so it knows the file,
// and follows it beside the run.

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"time"
)

// printTranscriptPoll is how often a run's transcript is looked for, and
// then read for what was written to it; a variable, so tests can look more
// often.
var printTranscriptPoll = 200 * time.Millisecond

// printTranscript follows a run's transcript.
type printTranscript struct {
	// projects is Claude Code's directory of projects, one directory each.
	projects string
	// name is the transcript's name in its project's directory.
	name string
	// from is where in it the run's part starts: its end before the run,
	// for a run that goes on a session.
	from       int64
	stop, done chan struct{}
}

// newPrintTranscript is the transcript of the session `sessionID`; nil when
// Claude Code's directory is not known.
func newPrintTranscript(sessionID string) *printTranscript {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil
		}
		dir = filepath.Join(home, ".claude")
	}
	return &printTranscript{
		projects: filepath.Join(dir, "projects"),
		name:     sessionID + ".jsonl",
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
}

// follow hands each line written to the transcript to `watch` as it comes,
// once it is found, which it tells `found` of, until the run's end.
func (tr *printTranscript) follow(watch *printWatch, found func()) {
	followFile(tr.open, tr.from, watch.line, found, tr.stop, tr.done)
}

// followFile hands each line written to the file `open` finds to `line` as
// it comes, from `from` in it, once it is found, which it tells `found` of,
// until `stop` closes; then it closes `done`.
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

// open opens the transcript in whichever project's directory it is: the
// run's directory names it, as Claude Code spells it.
func (tr *printTranscript) open() *os.File {
	entries, err := os.ReadDir(tr.projects)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if file, err := os.Open(filepath.Join(tr.projects, entry.Name(), tr.name)); err == nil {
			return file
		}
	}
	return nil
}

// startAtEnd has the transcript followed from where it is now: a run that
// goes on a session adds to its transcript.
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

// end reads the rest of the transcript once the run is over, and waits up
// to `wait` for it: false when it did not finish.
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

// newSessionID is a new session id for claude (a random UUID); empty when
// none could be made.
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
