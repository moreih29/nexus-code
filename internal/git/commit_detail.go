package git

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

const (
	commitDetailFieldSeparator = "\x00"
	commitDetailHeaderFields   = 7
	commitDetailFormat         = "%H%x00%P%x00%an%x00%ae%x00%cI%x00%s%x00%B%x00"
)

type CommitDetailParams struct {
	Cwd string `json:"cwd,omitempty"`
	SHA string `json:"sha"`
}

type CommitFileChange struct {
	Status  string `json:"status"`
	OldPath string `json:"oldPath,omitempty"`
	Path    string `json:"path"`
}

type CommitDetail struct {
	SHA         string             `json:"sha"`
	Parents     []string           `json:"parents"`
	Subject     string             `json:"subject"`
	Author      string             `json:"author"`
	AuthorEmail string             `json:"authorEmail"`
	CommitterTS string             `json:"committerTs"`
	Message     string             `json:"message"`
	Body        string             `json:"body"`
	Files       []CommitFileChange `json:"files"`
}

// CommitDetail returns metadata and first-parent file changes for one commit.
func (s *Service) CommitDetail(ctx context.Context, raw json.RawMessage) (any, error) {
	params, err := parseCommitDetailParams(raw)
	if err != nil {
		return nil, err
	}
	stdout, err := s.commitDetailGitOutput(ctx, params)
	if err != nil {
		return nil, err
	}
	detail, err := ParseCommitDetail(stdout)
	if err != nil {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: err.Error()}
	}
	return detail, nil
}

func parseCommitDetailParams(raw json.RawMessage) (CommitDetailParams, error) {
	var params CommitDetailParams
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return params, proto.ProtocolError("git.commitDetail params must include sha")
	}
	params.SHA = strings.TrimSpace(params.SHA)
	if params.SHA == "" {
		return params, proto.ProtocolError("git.commitDetail sha is required")
	}
	if strings.Contains(params.SHA, "\x00") {
		return params, proto.ProtocolError("git.commitDetail sha must not contain NUL")
	}
	if strings.Contains(params.Cwd, "\x00") {
		return params, proto.ProtocolError("git.commitDetail cwd must not contain NUL")
	}
	return params, nil
}

func (s *Service) commitDetailGitOutput(ctx context.Context, params CommitDetailParams) ([]byte, error) {
	args := []string{
		"show",
		"--no-ext-diff",
		"--find-renames",
		"--name-status",
		"-z",
		"--first-parent",
		"--format=" + commitDetailFormat,
		params.SHA,
	}
	cmd, err := s.command(ctx, args, params.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(err)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		return nil, commitDetailGitError(stderr.String())
	}
	return stdout.Bytes(), nil
}

func commitDetailGitError(stderr string) error {
	message := strings.TrimSpace(stderr)
	if message == "" {
		message = "git.commitDetail failed"
	}
	return proto.CodedError{Code: proto.CodeRequestFailed, Msg: message}
}

// ParseCommitDetail converts NUL-separated git show output into CommitDetail.
func ParseCommitDetail(stdout []byte) (CommitDetail, error) {
	fields := strings.Split(string(stdout), commitDetailFieldSeparator)
	if len(fields) < commitDetailHeaderFields {
		return CommitDetail{}, proto.ProtocolError("could not parse commit detail")
	}

	sha := fields[0]
	if sha == "" {
		return CommitDetail{}, proto.ProtocolError("could not parse commit detail SHA")
	}
	message := trimTrailingNewlines(fields[6])
	subject := fields[5]
	if subject == "" {
		subject = firstMessageLine(message)
	}
	return CommitDetail{
		SHA:         sha,
		Parents:     splitCommitParents(fields[1]),
		Subject:     subject,
		Author:      fields[2],
		AuthorEmail: fields[3],
		CommitterTS: fields[4],
		Message:     message,
		Body:        extractCommitBody(message, subject),
		Files:       parseNameStatusFields(fields[commitDetailHeaderFields:]),
	}, nil
}

func parseNameStatusFields(fields []string) []CommitFileChange {
	files := make([]CommitFileChange, 0, len(fields)/2)
	for i := 0; i < len(fields); {
		status := normalizeNameStatusField(fields[i])
		i++
		if status == "" {
			continue
		}
		if strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C") {
			if i+1 >= len(fields) {
				break
			}
			oldPath := normalizeNameStatusField(fields[i])
			path := normalizeNameStatusField(fields[i+1])
			i += 2
			if oldPath == "" || path == "" {
				break
			}
			files = append(files, CommitFileChange{Status: status, OldPath: oldPath, Path: path})
			continue
		}
		if i >= len(fields) {
			break
		}
		path := normalizeNameStatusField(fields[i])
		i++
		if path == "" {
			break
		}
		files = append(files, CommitFileChange{Status: status, Path: path})
	}
	return files
}

func normalizeNameStatusField(value string) string {
	return strings.TrimLeft(value, "\r\n")
}

func splitCommitParents(raw string) []string {
	parts := strings.Fields(raw)
	if parts == nil {
		return []string{}
	}
	return parts
}

func extractCommitBody(message string, subject string) string {
	if message == "" {
		return ""
	}
	lines := strings.Split(strings.ReplaceAll(message, "\r\n", "\n"), "\n")
	if len(lines) == 0 {
		return ""
	}
	if lines[0] == subject {
		if len(lines) > 1 && lines[1] == "" {
			return strings.TrimSpace(strings.Join(lines[2:], "\n"))
		}
		return strings.TrimSpace(strings.Join(lines[1:], "\n"))
	}
	return strings.TrimSpace(strings.Join(lines[1:], "\n"))
}

func trimTrailingNewlines(value string) string {
	return strings.TrimRight(value, "\r\n")
}

func firstMessageLine(message string) string {
	if idx := strings.IndexAny(message, "\r\n"); idx >= 0 {
		return message[:idx]
	}
	return message
}
