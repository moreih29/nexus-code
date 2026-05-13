package git

import (
	"fmt"
	"strconv"
	"strings"
)

// GitStatusEntry is one file entry in a GitStatus group.
type GitStatusEntry struct {
	RelPath      string  `json:"relPath"`
	OldRelPath   *string `json:"oldRelPath,omitempty"`
	XY           string  `json:"xy"`
	ConflictType *string `json:"conflictType"`
}

// BranchInfo carries porcelain v2 branch headers.
type BranchInfo struct {
	Current  string  `json:"current"`
	Upstream *string `json:"upstream"`
	Ahead    int     `json:"ahead"`
	Behind   int     `json:"behind"`
	IsUnborn bool    `json:"isUnborn"`
}

// RepoCapabilities mirrors the Source Control capability fields on GitStatus.
type RepoCapabilities struct {
	HasHEAD    bool     `json:"hasHEAD"`
	Remotes    []string `json:"remotes"`
	StashCount int      `json:"stashCount"`
	TagCount   int      `json:"tagCount"`
}

// GitStatus is the Go mirror of the shared GitStatus schema.
type GitStatus struct {
	Merge          []GitStatusEntry `json:"merge"`
	Staged         []GitStatusEntry `json:"staged"`
	Working        []GitStatusEntry `json:"working"`
	Untracked      []GitStatusEntry `json:"untracked"`
	Branch         *BranchInfo      `json:"branch"`
	Capabilities   RepoCapabilities `json:"capabilities"`
	OperationState map[string]any   `json:"operationState"`
	LastFetchedAt  *int64           `json:"lastFetchedAt"`
}

type porcelainBranchHeaders struct {
	head     string
	hasHead  bool
	oid      string
	hasOID   bool
	upstream *string
	ahead    int
	behind   int
}

var conflictTypeByXY = map[string]string{
	"DD": "both-deleted",
	"AU": "added-by-us",
	"UD": "deleted-by-them",
	"UA": "added-by-them",
	"DU": "deleted-by-us",
	"AA": "both-added",
	"UU": "both-modified",
}

// ParsePorcelainV2 parses `git status --porcelain=v2` output into GitStatus.
// It is pure: callers supply raw stdout and receive schema-shaped status data
// with non-porcelain fields set to their defaults.
func ParsePorcelainV2(stdout []byte) (GitStatus, error) {
	status := defaultGitStatus()
	records, nulDelimited := splitPorcelainRecords(stdout)
	branch := porcelainBranchHeaders{}

	for index := 0; index < len(records); index++ {
		record := records[index]
		if record == "" {
			continue
		}

		switch {
		case strings.HasPrefix(record, "# "):
			parseBranchHeader(record, &branch)
		case strings.HasPrefix(record, "1 "):
			entry, err := parseTrackedRecord(record, 8)
			if err != nil {
				return status, err
			}
			appendTrackedEntry(&status, entry)
		case strings.HasPrefix(record, "2 "):
			var oldPath *string
			if nulDelimited {
				if index+1 >= len(records) || records[index+1] == "" {
					return status, fmt.Errorf("porcelain rename record missing old path")
				}
				old := records[index+1]
				oldPath = &old
				index++
			}
			entry, err := parseRenamedOrCopiedRecord(record, oldPath)
			if err != nil {
				return status, err
			}
			appendTrackedEntry(&status, entry)
		case strings.HasPrefix(record, "u "):
			entry, err := parseTrackedRecord(record, 10)
			if err != nil {
				return status, err
			}
			status.Merge = append(status.Merge, entry)
		case strings.HasPrefix(record, "? "):
			status.Untracked = append(status.Untracked, GitStatusEntry{RelPath: record[2:], XY: "??"})
		case strings.HasPrefix(record, "! "):
			// Ignored entries are intentionally not part of GitStatus.
		default:
			return status, fmt.Errorf("unsupported porcelain record: %q", record)
		}
	}

	status.Branch = buildBranchInfo(branch)
	if branch.hasOID {
		status.Capabilities.HasHEAD = branch.oid != "(initial)"
	}
	return status, nil
}

func defaultGitStatus() GitStatus {
	return GitStatus{
		Merge:          []GitStatusEntry{},
		Staged:         []GitStatusEntry{},
		Working:        []GitStatusEntry{},
		Untracked:      []GitStatusEntry{},
		Capabilities:   RepoCapabilities{Remotes: []string{}},
		OperationState: map[string]any{"kind": "none"},
	}
}

func splitPorcelainRecords(stdout []byte) ([]string, bool) {
	text := string(stdout)
	if strings.Contains(text, "\x00") {
		parts := strings.Split(text, "\x00")
		return trimEmptyRecords(parts), true
	}
	return trimEmptyRecords(strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == '\r' })), false
}

func trimEmptyRecords(records []string) []string {
	trimmed := records[:0]
	for _, record := range records {
		if record != "" {
			trimmed = append(trimmed, record)
		}
	}
	return trimmed
}

func parseBranchHeader(record string, branch *porcelainBranchHeaders) {
	line := strings.TrimPrefix(record, "# ")
	switch {
	case strings.HasPrefix(line, "branch.head "):
		branch.head = strings.TrimPrefix(line, "branch.head ")
		branch.hasHead = true
	case strings.HasPrefix(line, "branch.oid "):
		branch.oid = strings.TrimPrefix(line, "branch.oid ")
		branch.hasOID = true
	case strings.HasPrefix(line, "branch.upstream "):
		upstream := strings.TrimPrefix(line, "branch.upstream ")
		branch.upstream = &upstream
	case strings.HasPrefix(line, "branch.ab "):
		fields := strings.Fields(line)
		if len(fields) == 3 {
			branch.ahead = parseSignedCount(fields[1], '+')
			branch.behind = parseSignedCount(fields[2], '-')
		}
	}
}

func parseSignedCount(raw string, sign byte) int {
	if len(raw) < 2 || raw[0] != sign {
		return 0
	}
	value, err := strconv.Atoi(raw[1:])
	if err != nil || value < 0 {
		return 0
	}
	return value
}

func buildBranchInfo(branch porcelainBranchHeaders) *BranchInfo {
	if !branch.hasHead || branch.head == "(detached)" {
		return nil
	}
	return &BranchInfo{
		Current:  branch.head,
		Upstream: branch.upstream,
		Ahead:    branch.ahead,
		Behind:   branch.behind,
		IsUnborn: branch.oid == "(initial)",
	}
}

func parseTrackedRecord(record string, prefixFieldCount int) (GitStatusEntry, error) {
	fields, path, err := splitPrefixAndPath(record, prefixFieldCount)
	if err != nil {
		return GitStatusEntry{}, err
	}
	xy := fields[1]
	if len(xy) != 2 {
		return GitStatusEntry{}, fmt.Errorf("invalid porcelain XY %q", xy)
	}
	return GitStatusEntry{RelPath: path, XY: xy, ConflictType: conflictTypeFromXY(xy)}, nil
}

func parseRenamedOrCopiedRecord(record string, nulOldPath *string) (GitStatusEntry, error) {
	fields, path, err := splitPrefixAndPath(record, 9)
	if err != nil {
		return GitStatusEntry{}, err
	}
	xy := fields[1]
	if len(xy) != 2 {
		return GitStatusEntry{}, fmt.Errorf("invalid porcelain XY %q", xy)
	}
	entry := GitStatusEntry{RelPath: path, XY: xy, ConflictType: conflictTypeFromXY(xy)}
	if nulOldPath != nil {
		entry.OldRelPath = nulOldPath
		return entry, nil
	}
	if tab := strings.Index(path, "\t"); tab >= 0 {
		old := path[tab+1:]
		entry.RelPath = path[:tab]
		entry.OldRelPath = &old
	}
	return entry, nil
}

func splitPrefixAndPath(record string, prefixFieldCount int) ([]string, string, error) {
	fields := make([]string, 0, prefixFieldCount)
	cursor := 0
	for i := 0; i < prefixFieldCount; i++ {
		nextSpace := strings.IndexByte(record[cursor:], ' ')
		if nextSpace < 0 {
			return nil, "", fmt.Errorf("malformed porcelain record: %q", record)
		}
		nextSpace += cursor
		fields = append(fields, record[cursor:nextSpace])
		cursor = nextSpace + 1
	}
	if cursor >= len(record) {
		return nil, "", fmt.Errorf("porcelain record missing path: %q", record)
	}
	return fields, record[cursor:], nil
}

func appendTrackedEntry(status *GitStatus, entry GitStatusEntry) {
	if _, ok := conflictTypeByXY[entry.XY]; ok {
		status.Merge = append(status.Merge, entry)
		return
	}
	if isStagedCode(entry.XY[0]) {
		status.Staged = append(status.Staged, entry)
	}
	if isWorkingCode(entry.XY[1]) {
		status.Working = append(status.Working, entry)
	}
}

func conflictTypeFromXY(xy string) *string {
	value, ok := conflictTypeByXY[xy]
	if !ok {
		return nil
	}
	return &value
}

func isStagedCode(code byte) bool {
	switch code {
	case 'M', 'A', 'D', 'R', 'C':
		return true
	default:
		return false
	}
}

func isWorkingCode(code byte) bool {
	switch code {
	case 'M', 'D', 'T':
		return true
	default:
		return false
	}
}
