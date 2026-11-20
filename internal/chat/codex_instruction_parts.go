package chat

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Codex 0.170 caps each turn/start additionalContext value at 1,000
// approximate tokens, calculated at four UTF-8 bytes per token.
const codexContextValueLimit = 4000
const codexInstructionPartPrefix = codexInstructions + "-part-"

func addCodexInstructionParts(fragments map[string]json.RawMessage, value string) {
	parts := make([]string, 0, len(value)/codexContextValueLimit+1)
	for rest := value; rest != ""; {
		end := min(len(rest), codexContextValueLimit)
		if end < len(rest) {
			for !utf8.RuneStart(rest[end]) {
				end--
			}
			// Prefer keeping lines together when the boundary is close.
			if line := strings.LastIndexByte(rest[:end], '\n') + 1; line > end*3/4 {
				end = line
			}
		}
		parts = append(parts, rest[:end])
		rest = rest[end:]
	}
	// Codex orders the opaque keys lexically. Including the full update's
	// digest also makes Codex emit every part when an update changes.
	digest := sha256.Sum256([]byte(value))
	for i, part := range parts {
		key := fmt.Sprintf("%s%04d-%04d-%x", codexInstructionPartPrefix, i+1, len(parts), digest)
		addCodexFragment(fragments, key, part)
	}
}

type codexInstructionRollout struct {
	digest string
	parts  map[int]string
}

func (r *codexInstructionRollout) readPart(latest map[string]string, key, value string) {
	index, rest, _ := strings.Cut(key, "-")
	count, digest, _ := strings.Cut(rest, "-")
	i, indexErr := strconv.Atoi(index)
	n, countErr := strconv.Atoi(count)
	if indexErr != nil || countErr != nil || i < 1 || i > n || len(digest) != sha256.Size*2 {
		return
	}
	if r.digest != digest {
		r.digest = digest
		r.parts = make(map[int]string)
		// A partial update counts as earlier instructions for replacement,
		// but only a complete update can suppress injection.
		latest[codexInstructions] = "\x00"
	}
	r.parts[i] = value
	if len(r.parts) != n {
		return
	}
	var text strings.Builder
	for i := 1; i <= n; i++ {
		text.WriteString(r.parts[i])
	}
	if fmt.Sprintf("%x", sha256.Sum256([]byte(text.String()))) == digest {
		latest[codexInstructions] = codexInstructionsInHistory(text.String())
	}
}

func codexInstructionsInHistory(value string) string {
	value = strings.TrimPrefix(value, instructionsReplaced)
	if body, count, ok := strings.Cut(value, refreshSuffix); ok {
		if _, err := strconv.ParseUint(count, 10, 64); err == nil {
			return body
		}
	}
	return value
}
