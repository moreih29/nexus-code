package chat

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	codexFileLinks       = "nexus-file-links"
	codexInstructions    = "nexus-agent-instructions"
	instructionsCleared  = "NexusCode instructions were cleared. Disregard all earlier NexusCode instructions for this conversation."
	instructionsReplaced = "Follow the current NexusCode instructions below in place of any earlier NexusCode instructions.\n\n"
	codexCLI             = "nexus-cli"
	codexCommands        = "nexus-cli-commands"
	refreshSuffix        = "\n\nNexusCode context refresh after compaction: "
	cliDisabled          = "NexusCode's CLI guidance is disabled for this tab. Disregard earlier NexusCode CLI guidance for this conversation."
)

// maxInitializeBytes bounds the lines checked for initialize: it is small, and
// other lines may carry several MiB of images.
const maxInitializeBytes = 16 * 1024

type codexContext struct {
	Files        string           `json:"files"`
	CLI          *codexCLIContext `json:"cli"`
	Instructions string           `json:"instructions"`
}

type codexCLIContext struct {
	Status   string `json:"status"`
	Commands string `json:"commands"`
}

type codexGuidance struct {
	// Codex deduplicates additionalContext within an app-server process. On
	// resume or fork we can skip a fragment already carried by the rollout
	// until its current value changes.
	inherited       map[string]string
	hadCLI          bool
	hadInstructions bool
	cliEnabled      bool
	compactions     uint64
}

// noteCodexInitialize records whether the program's initialize request asked
// for experimentalApi. Only the first counts: Codex refuses a second one and
// keeps the first's capabilities. A program this agent never saw initialize,
// as when its initialize failed, is treated as not having asked.
func (p *process) noteCodexInitialize(data []byte) {
	if p.codexInitialized || len(data) > maxInitializeBytes || !bytes.Contains(data, []byte(`"initialize"`)) {
		return
	}
	var request struct {
		Method string `json:"method"`
		Params struct {
			Capabilities *struct {
				ExperimentalAPI bool `json:"experimentalApi"`
			} `json:"capabilities"`
		} `json:"params"`
	}
	if json.Unmarshal(data, &request) != nil || request.Method != "initialize" {
		return
	}
	p.codexInitialized = true
	p.codexExperimental = request.Params.Capabilities != nil && request.Params.Capabilities.ExperimentalAPI
}

// prepareCodexContext stages guidance changes until stdin accepts the frame.
func (p *process) prepareCodexContext(data []byte, context codexContext) ([]byte, func()) {
	// Without experimentalApi Codex rejects every turn/start that carries
	// additionalContext, so a turn goes without the guidance instead.
	if !p.codexExperimental {
		return data, nil
	}
	var request map[string]json.RawMessage
	var method string
	var params map[string]json.RawMessage
	var threadID string
	if json.Unmarshal(data, &request) != nil ||
		json.Unmarshal(request["method"], &method) != nil || method != "turn/start" ||
		json.Unmarshal(request["params"], &params) != nil ||
		json.Unmarshal(params["threadId"], &threadID) != nil || !sessionIDPattern.MatchString(threadID) {
		return data, nil
	}
	state := p.codexGuidance[threadID]
	compactions := p.codexCompactions.Load()
	cliEnabled := context.CLI != nil
	// Omitting the commands while disabled clears Codex's live dedup cache
	// for them. On re-enable, check which commands remain in history.
	if state == nil || state.compactions != compactions || (cliEnabled && !state.cliEnabled) {
		inherited := make(map[string]string)
		readCodexGuidance(p.codexHome(), threadID, inherited)
		if state != nil && state.compactions == compactions {
			// Re-enabling CLI guidance must not resend unchanged independent fragments.
			for _, key := range []string{codexFileLinks, codexInstructions} {
				if value := state.inherited[key]; value != "" {
					inherited[key] = value
				}
			}
		}
		state = &codexGuidance{
			inherited:       inherited,
			hadCLI:          inherited[codexCLI] != "" || (state != nil && state.hadCLI),
			hadInstructions: inherited[codexInstructions] != "" || (state != nil && state.hadInstructions),
			compactions:     compactions,
		}
	} else {
		copy := *state
		copy.inherited = maps.Clone(state.inherited)
		state = &copy
	}

	var fragments map[string]json.RawMessage
	if raw := params["additionalContext"]; raw != nil && json.Unmarshal(raw, &fragments) != nil {
		return data, nil
	}
	if fragments == nil {
		fragments = make(map[string]json.RawMessage)
	}

	state.cliEnabled = cliEnabled
	values := map[string]string{codexFileLinks: context.Files}
	replacingInstructions := state.hadInstructions
	if context.Instructions != "" {
		state.hadInstructions = true
		values[codexInstructions] = context.Instructions
	} else if state.hadInstructions {
		values[codexInstructions] = instructionsCleared
	}
	if cliEnabled {
		state.hadCLI = true
		values[codexCLI] = context.CLI.Status
		values[codexCommands] = context.CLI.Commands
	} else if state.hadCLI {
		values[codexCLI] = cliDisabled
	}
	added := false
	for key, value := range values {
		if value == "" || value == state.inherited[key] {
			continue
		}
		if key == codexFileLinks || key == codexInstructions {
			state.inherited[key] = value
		} else {
			delete(state.inherited, key)
		}
		// The rollout keeps older application fragments as developer messages.
		if key == codexInstructions && replacingInstructions && context.Instructions != "" {
			value = instructionsReplaced + value
		}
		// If compaction removed the fragment, Codex's live deduplication
		// can still remember its previous value.
		if compactions != 0 {
			value += fmt.Sprint(refreshSuffix, compactions)
		}
		fragments[key], _ = json.Marshal(map[string]string{"kind": "application", "value": value})
		added = true
	}
	commit := func() {
		if p.codexGuidance == nil {
			p.codexGuidance = make(map[string]*codexGuidance)
		}
		p.codexGuidance[threadID] = state
	}
	if !added {
		return data, commit
	}
	params["additionalContext"], _ = json.Marshal(fragments)
	// Encode the edited request once. In particular, params may contain
	// several MiB of image data that should not be encoded on its own first.
	out := make(map[string]any, len(request))
	for key, value := range request {
		out[key] = value
	}
	out["params"] = params
	result, _ := json.Marshal(out)
	return result, commit
}

// Use the environment of the running app server, after profile resolution on
// its own host. A login-shell default might differ from the selected profile.
func (p *process) codexHome() string {
	homeKey := "HOME"
	if runtime.GOOS == "windows" {
		homeKey = "USERPROFILE"
	}
	var home string
	for _, entry := range p.cmd.Env {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if sameEnvKey(key, "CODEX_HOME") && value != "" {
			if !filepath.IsAbs(value) {
				return filepath.Join(p.cmd.Dir, value)
			}
			return value
		}
		if sameEnvKey(key, homeKey) {
			home = value
		}
	}
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".codex")
}

type codexGuidanceRecord struct {
	Type    string `json:"type"`
	Payload struct {
		codexGuidanceItem
		Parent      string `json:"forked_from_id"`
		HistoryBase struct {
			EndByteOffset int64 `json:"end_byte_offset"`
		} `json:"history_base"`
		Replacement []codexGuidanceItem `json:"replacement_history"`
	} `json:"payload"`
}

type codexGuidanceItem struct {
	Type    string `json:"type"`
	Role    string `json:"role"`
	Content []struct {
		Text string `json:"text"`
	} `json:"content"`
}

// Bound startup I/O even with large tool output or long fork chains. If the
// bounded history lacks a marker, send the current guidance.
const codexGuidanceScanBytes = 2 * 1024 * 1024
const codexGuidanceScanForks = 4

func readCodexGuidance(home, threadID string, latest map[string]string) {
	if home == "" {
		return
	}
	var end int64
	for range codexGuidanceScanForks {
		own, parent, parentEnd := codexGuidanceInRollout(keptRollout(home, threadID), end)
		for key, value := range own {
			if latest[key] == "" {
				latest[key] = value
			}
		}
		if latest[codexFileLinks] != "" && latest[codexCLI] != "" && latest[codexCommands] != "" && latest[codexInstructions] != "" {
			return
		}
		if !sessionIDPattern.MatchString(parent) || parentEnd <= 0 {
			return
		}
		threadID, end = parent, parentEnd
	}
}

// Scan a bounded tail ending at this fork's inherited byte boundary when
// present. Earlier markers are inactive after compaction or rollback. Only
// a marker in the replacement history or a subsequent record can suppress
// injection in that case.
func codexGuidanceInRollout(path string, end int64) (map[string]string, string, int64) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, "", 0
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, "", 0
	}
	defer file.Close()
	if end <= 0 || end > info.Size() {
		end = info.Size()
	}
	start := max(0, end-codexGuidanceScanBytes)
	lines := bufio.NewScanner(io.NewSectionReader(file, start, end-start))
	lines.Buffer(make([]byte, 8*1024), codexGuidanceScanBytes+1)
	if start > 0 {
		lines.Scan() // partial first line
	}

	latest := make(map[string]string)
	var parent string
	var parentEnd int64
	for lines.Scan() {
		line := lines.Bytes()
		if bytes.Contains(line, []byte("session_meta")) ||
			bytes.Contains(line, []byte("compacted")) ||
			bytes.Contains(line, []byte("thread_rolled_back")) ||
			bytes.Contains(line, []byte(codexFileLinks)) || bytes.Contains(line, []byte(codexCLI)) ||
			bytes.Contains(line, []byte(codexInstructions)) {
			var record codexGuidanceRecord
			if json.Unmarshal(line, &record) == nil {
				switch record.Type {
				case "session_meta":
					if start == 0 && parent == "" {
						parent, parentEnd = record.Payload.Parent, record.Payload.HistoryBase.EndByteOffset
					}
				case "response_item":
					record.Payload.codexGuidanceItem.readFragments(latest)
				case "compacted":
					clear(latest)
					parent, parentEnd = "", 0
					for _, item := range record.Payload.Replacement {
						item.readFragments(latest)
					}
				case "event_msg":
					if record.Payload.Type == "thread_rolled_back" {
						clear(latest)
						parent, parentEnd = "", 0
					}
				}
			}
		}
	}
	return latest, parent, parentEnd
}

func (item codexGuidanceItem) readFragments(latest map[string]string) {
	if item.Type != "message" || item.Role != "developer" {
		return
	}
	for _, content := range item.Content {
		for _, key := range []string{codexFileLinks, codexCLI, codexCommands, codexInstructions} {
			if value, ok := strings.CutPrefix(content.Text, "<"+key+">"); ok {
				if value, ok := strings.CutSuffix(value, "</"+key+">"); ok {
					if key == codexInstructions {
						value = strings.TrimPrefix(value, instructionsReplaced)
					}
					latest[key], _, _ = strings.Cut(value, refreshSuffix)
				}
			}
		}
	}
}

func isCodexCompaction(line []byte) bool {
	if !bytes.Contains(line, []byte("contextCompaction")) &&
		!bytes.Contains(line, []byte("thread/compacted")) {
		return false
	}
	var notification struct {
		Method string `json:"method"`
		Params struct {
			Item struct {
				Type string `json:"type"`
			} `json:"item"`
		} `json:"params"`
	}
	if json.Unmarshal(line, &notification) != nil {
		return false
	}
	return notification.Method == "thread/compacted" ||
		(notification.Method == "item/completed" && notification.Params.Item.Type == "contextCompaction")
}
