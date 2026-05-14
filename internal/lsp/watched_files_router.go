package lsp

import (
	"encoding/json"
	"errors"
	"path"
	"path/filepath"
	"strings"

	agentfs "github.com/nexus-code/nexus-code/internal/fs"
)

const (
	methodClientRegisterCapability = "client/registerCapability"
	methodDidChangeWatchedFiles    = "workspace/didChangeWatchedFiles"

	lspFileChangeCreated = 1
	lspFileChangeChanged = 2
	lspFileChangeDeleted = 3
)

type didChangeWatchedFilesParams struct {
	Changes []lspFileEvent `json:"changes"`
}

type lspFileEvent struct {
	URI  string `json:"uri"`
	Type int    `json:"type"`
}

type watchedFileRegistration struct {
	id       string
	matchAll bool
	watchers []watchedFileWatcher
}

type watchedFileWatcher struct {
	glob watchedFileGlob
}

type watchedFileGlob struct {
	patterns [][]string
}

// HandleFSChanged routes one already-debounced fs.changed payload to active LSP
// servers that successfully registered workspace/didChangeWatchedFiles.
func (s *Service) HandleFSChanged(payload agentfs.FsChangedPayload) error {
	if len(payload.Changes) == 0 {
		return nil
	}

	servers := s.activeServers()
	var errs []error
	for _, server := range servers {
		changes := server.matchingWatchedFileChanges(payload.Changes)
		if len(changes) == 0 {
			continue
		}
		server.resetIdleTimer()
		if err := server.notify(methodDidChangeWatchedFiles, didChangeWatchedFilesParams{Changes: changes}); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (s *Service) activeServers() []*serverProcess {
	s.mu.Lock()
	defer s.mu.Unlock()

	servers := make([]*serverProcess, 0, len(s.servers))
	for _, server := range s.servers {
		servers = append(servers, server)
	}
	return servers
}

func watchedFileRegistrationsFromServerRequest(method string, params json.RawMessage) []watchedFileRegistration {
	if method != methodClientRegisterCapability {
		return nil
	}
	return parseWatchedFileRegistrations(params)
}

func parseWatchedFileRegistrations(params json.RawMessage) []watchedFileRegistration {
	var parsed struct {
		Registrations []struct {
			ID              string          `json:"id"`
			Method          string          `json:"method"`
			RegisterOptions json.RawMessage `json:"registerOptions"`
		} `json:"registrations"`
	}
	if len(params) == 0 || json.Unmarshal(params, &parsed) != nil {
		return nil
	}

	registrations := make([]watchedFileRegistration, 0, len(parsed.Registrations))
	for _, registration := range parsed.Registrations {
		if registration.Method != methodDidChangeWatchedFiles {
			continue
		}
		registrations = append(registrations, newWatchedFileRegistration(registration.ID, registration.RegisterOptions))
	}
	return registrations
}

func newWatchedFileRegistration(id string, registerOptions json.RawMessage) watchedFileRegistration {
	registration := watchedFileRegistration{id: id}
	for _, watcher := range parseWatchedFileWatchers(registerOptions) {
		registration.watchers = append(registration.watchers, watcher)
	}
	if len(registration.watchers) == 0 {
		registration.matchAll = true
	}
	return registration
}

func parseWatchedFileWatchers(registerOptions json.RawMessage) []watchedFileWatcher {
	var parsed struct {
		Watchers []struct {
			GlobPattern json.RawMessage `json:"globPattern"`
		} `json:"watchers"`
	}
	if len(registerOptions) == 0 || json.Unmarshal(registerOptions, &parsed) != nil || len(parsed.Watchers) == 0 {
		return nil
	}

	watchers := make([]watchedFileWatcher, 0, len(parsed.Watchers))
	for _, watcher := range parsed.Watchers {
		pattern, ok := globPatternString(watcher.GlobPattern)
		if !ok {
			continue
		}
		glob, ok := newWatchedFileGlob(pattern)
		if !ok {
			continue
		}
		watchers = append(watchers, watchedFileWatcher{glob: glob})
	}
	return watchers
}

func globPatternString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}

	var pattern string
	if json.Unmarshal(raw, &pattern) == nil {
		return pattern, strings.TrimSpace(pattern) != ""
	}

	var relativePattern struct {
		Pattern string `json:"pattern"`
	}
	if json.Unmarshal(raw, &relativePattern) != nil || strings.TrimSpace(relativePattern.Pattern) == "" {
		return "", false
	}
	return relativePattern.Pattern, true
}

func (p *serverProcess) addWatchedFileRegistrations(registrations []watchedFileRegistration) {
	if len(registrations) == 0 {
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.exited {
		return
	}
	p.watchedFileRegistrations = append(p.watchedFileRegistrations, registrations...)
}

func (p *serverProcess) matchingWatchedFileChanges(changes []agentfs.FsChange) []lspFileEvent {
	p.mu.Lock()
	registrations := append([]watchedFileRegistration(nil), p.watchedFileRegistrations...)
	p.mu.Unlock()
	if len(registrations) == 0 {
		return nil
	}

	lspChanges := make([]lspFileEvent, 0, len(changes))
	for _, change := range changes {
		relPath, ok := normalizeRelativeMatchPath(change.RelPath)
		if !ok || !watchedFileRegistrationsMatchNormalized(registrations, relPath) {
			continue
		}
		changeType, ok := lspFileChangeType(change.Kind)
		if !ok {
			continue
		}
		lspChanges = append(lspChanges, lspFileEvent{
			URI:  fileURI(filepath.Join(p.workspaceRoot, filepath.FromSlash(relPath))),
			Type: changeType,
		})
	}
	return lspChanges
}

func watchedFileRegistrationsMatch(registrations []watchedFileRegistration, relPath string) bool {
	normalized, ok := normalizeRelativeMatchPath(relPath)
	if !ok {
		return false
	}
	return watchedFileRegistrationsMatchNormalized(registrations, normalized)
}

func watchedFileRegistrationsMatchNormalized(registrations []watchedFileRegistration, relPath string) bool {
	for _, registration := range registrations {
		if registration.matchesNormalized(relPath) {
			return true
		}
	}
	return false
}

func (r watchedFileRegistration) matchesNormalized(relPath string) bool {
	if r.matchAll {
		return true
	}
	for _, watcher := range r.watchers {
		if watcher.glob.matchesNormalized(relPath) {
			return true
		}
	}
	return false
}

func lspFileChangeType(kind agentfs.FsChangeKind) (int, bool) {
	switch kind {
	case agentfs.FsChangeAdded:
		return lspFileChangeCreated, true
	case agentfs.FsChangeModified:
		return lspFileChangeChanged, true
	case agentfs.FsChangeDeleted:
		return lspFileChangeDeleted, true
	default:
		return 0, false
	}
}

func newWatchedFileGlob(pattern string) (watchedFileGlob, bool) {
	normalized, ok := normalizeGlobPattern(pattern)
	if !ok {
		return watchedFileGlob{}, false
	}

	expanded, ok := expandGlobBraces(normalized)
	if !ok {
		return watchedFileGlob{}, false
	}

	glob := watchedFileGlob{patterns: make([][]string, 0, len(expanded))}
	for _, pattern := range expanded {
		segments := strings.Split(pattern, "/")
		if !validGlobSegments(segments) {
			return watchedFileGlob{}, false
		}
		glob.patterns = append(glob.patterns, segments)
	}
	return glob, len(glob.patterns) > 0
}

func normalizeGlobPattern(pattern string) (string, bool) {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" || strings.Contains(pattern, "\x00") || strings.Contains(pattern, "://") || hasWindowsDrivePrefix(pattern) {
		return "", false
	}
	pattern = strings.ReplaceAll(pattern, "\\", "/")
	for strings.HasPrefix(pattern, "./") {
		pattern = strings.TrimPrefix(pattern, "./")
	}
	if pattern == "" || path.IsAbs(pattern) || filepath.IsAbs(pattern) {
		return "", false
	}
	return pattern, true
}

func validGlobSegments(segments []string) bool {
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
		if strings.Contains(segment, "**") && segment != "**" {
			return false
		}
		if segment == "**" {
			continue
		}
		if _, err := path.Match(segment, ""); err != nil {
			return false
		}
	}
	return true
}

func (g watchedFileGlob) matchesNormalized(relPath string) bool {
	segments := strings.Split(relPath, "/")
	for _, pattern := range g.patterns {
		if matchGlobSegments(pattern, segments) {
			return true
		}
	}
	return false
}

func matchGlobSegments(pattern []string, relPath []string) bool {
	type key struct {
		patternIndex int
		relIndex     int
	}
	memo := make(map[key]bool)

	var match func(int, int) bool
	match = func(patternIndex int, relIndex int) bool {
		k := key{patternIndex: patternIndex, relIndex: relIndex}
		if result, ok := memo[k]; ok {
			return result
		}

		var result bool
		switch {
		case patternIndex == len(pattern):
			result = relIndex == len(relPath)
		case pattern[patternIndex] == "**":
			result = match(patternIndex+1, relIndex)
			for nextRelIndex := relIndex; !result && nextRelIndex < len(relPath); nextRelIndex++ {
				result = match(patternIndex+1, nextRelIndex+1)
			}
		case relIndex < len(relPath):
			segmentMatched, _ := path.Match(pattern[patternIndex], relPath[relIndex])
			result = segmentMatched && match(patternIndex+1, relIndex+1)
		default:
			result = false
		}

		memo[k] = result
		return result
	}

	return match(0, 0)
}

func expandGlobBraces(pattern string) ([]string, bool) {
	expanded := []string{pattern}
	for {
		changed := false
		next := make([]string, 0, len(expanded))
		for _, candidate := range expanded {
			start, end, alternatives, found, ok := firstBraceAlternatives(candidate)
			if !ok {
				return nil, false
			}
			if !found {
				next = append(next, candidate)
				continue
			}
			changed = true
			for _, alternative := range alternatives {
				next = append(next, candidate[:start]+alternative+candidate[end+1:])
				if len(next) > 64 {
					return nil, false
				}
			}
		}
		expanded = next
		if !changed {
			return expanded, true
		}
	}
}

func firstBraceAlternatives(pattern string) (int, int, []string, bool, bool) {
	for start := 0; start < len(pattern); start++ {
		if pattern[start] == '\\' {
			start++
			continue
		}
		if pattern[start] != '{' {
			continue
		}

		depth := 1
		partStart := start + 1
		hasComma := false
		var alternatives []string
		for end := start + 1; end < len(pattern); end++ {
			switch pattern[end] {
			case '\\':
				end++
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					if !hasComma {
						return 0, 0, nil, false, true
					}
					alternatives = append(alternatives, pattern[partStart:end])
					return start, end, alternatives, true, true
				}
			case ',':
				if depth == 1 {
					hasComma = true
					alternatives = append(alternatives, pattern[partStart:end])
					partStart = end + 1
				}
			}
		}
		return 0, 0, nil, false, false
	}
	return 0, 0, nil, false, true
}

func normalizeRelativeMatchPath(relPath string) (string, bool) {
	relPath = strings.ReplaceAll(relPath, "\\", "/")
	for strings.HasPrefix(relPath, "./") {
		relPath = strings.TrimPrefix(relPath, "./")
	}
	if relPath == "" || path.IsAbs(relPath) {
		return "", false
	}
	for _, segment := range strings.Split(relPath, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", false
		}
	}
	return relPath, true
}

func hasWindowsDrivePrefix(pattern string) bool {
	if len(pattern) < 3 || pattern[1] != ':' {
		return false
	}
	first := pattern[0]
	return ((first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z')) &&
		(pattern[2] == '/' || pattern[2] == '\\')
}
