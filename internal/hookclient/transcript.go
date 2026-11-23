package hookclient

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strings"
	"time"
)

const transcriptMaxBytes int64 = 2 * 1024 * 1024

const transcriptPreviewMaxChars = 500

const transcriptLineMaxBytes = 1 * 1024 * 1024

const transcriptStableMaxWait = 1 * time.Second

const transcriptStableInterval = 100 * time.Millisecond

func extractLastAssistantText(transcriptPath string) string {
	if transcriptPath == "" {
		return ""
	}
	waitForTranscriptStable(transcriptPath, transcriptStableMaxWait, transcriptStableInterval)
	return readAssistantTextSinceLastUser(transcriptPath)
}

func waitForTranscriptStable(path string, maxWait, interval time.Duration) {
	waitUntilSteady(func() (fileMark, bool) {
		info, err := os.Stat(path)
		if err != nil {
			return fileMark{}, false
		}
		return fileMark{mtime: info.ModTime(), size: info.Size()}, true
	}, maxWait, interval, time.Now, time.Sleep)
}

type fileMark struct {
	mtime time.Time
	size  int64
}

func waitUntilSteady(
	mark func() (fileMark, bool),
	maxWait, interval time.Duration,
	now func() time.Time,
	sleep func(time.Duration),
) {
	deadline := now().Add(maxWait)
	prev, ok := mark()
	if !ok {
		return
	}
	for now().Before(deadline) {
		sleep(interval)
		next, ok := mark()
		if !ok || (next.mtime.Equal(prev.mtime) && next.size == prev.size) {
			return
		}
		prev = next
	}
}

func readAssistantTextSinceLastUser(path string) string {
	info, err := os.Stat(path)
	if err != nil || info.Size() == 0 {
		return ""
	}

	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	var reader io.Reader = f
	if info.Size() > transcriptMaxBytes {
		if _, err := f.Seek(info.Size()-transcriptMaxBytes, io.SeekStart); err != nil {
			return ""
		}
		br := bufio.NewReaderSize(f, 64*1024)
		if _, err := br.ReadString('\n'); err != nil && err != io.EOF {
			return ""
		}
		reader = br
	}

	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), transcriptLineMaxBytes)

	var accum []string
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		role, text, ok := decodeRoleAndText(line)
		if !ok {
			continue
		}
		switch role {
		case "user":
			accum = accum[:0]
		case "assistant":
			if text != "" {
				accum = append(accum, text)
			}
		}
	}

	if len(accum) == 0 {
		return ""
	}
	joined := strings.Join(accum, " ")
	return truncateChars(normalizeSingleLine(joined), transcriptPreviewMaxChars)
}

type transcriptLine struct {
	Message *transcriptMessage `json:"message"`
}

type transcriptMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type transcriptContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func decodeRoleAndText(line []byte) (role, text string, ok bool) {
	var parsed transcriptLine
	if err := json.Unmarshal(line, &parsed); err != nil {
		return "", "", false
	}
	if parsed.Message == nil {
		return "", "", false
	}
	role = parsed.Message.Role
	if role != "assistant" {
		return role, "", true
	}
	t, _ := decodeContentText(parsed.Message.Content)
	return role, t, true
}

func decodeContentText(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}

	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return strings.TrimSpace(asString), true
	}

	var blocks []transcriptContentBlock
	if err := json.Unmarshal(raw, &blocks); err == nil {
		parts := make([]string, 0, len(blocks))
		for _, b := range blocks {
			if b.Type != "text" {
				continue
			}
			t := strings.TrimSpace(b.Text)
			if t != "" {
				parts = append(parts, t)
			}
		}
		if len(parts) == 0 {
			return "", true
		}
		return strings.Join(parts, " "), true
	}

	return "", false
}

func normalizeSingleLine(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	lastWasSpace := false
	for _, r := range s {
		if r == '\n' || r == '\r' || r == '\t' || r == ' ' {
			if !lastWasSpace && b.Len() > 0 {
				b.WriteByte(' ')
				lastWasSpace = true
			}
			continue
		}
		b.WriteRune(r)
		lastWasSpace = false
	}
	out := b.String()
	return strings.TrimSpace(out)
}

func truncateChars(s string, maxChars int) string {
	if maxChars <= 0 {
		return ""
	}
	count := 0
	for i := range s {
		if count == maxChars {
			return s[:i] + "…"
		}
		count++
	}
	return s
}
