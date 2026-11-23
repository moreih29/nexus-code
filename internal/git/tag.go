package git

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

type Tag struct {
	Name       string  `json:"name"`
	SHA        string  `json:"sha"`
	Message    *string `json:"message"`
	Type       string  `json:"type"`
	TaggerDate *int64  `json:"taggerDate"`
}

type RemoteTag struct {
	Remote string `json:"remote"`
	Name   string `json:"name"`
	SHA    string `json:"sha"`
	Scope  string `json:"scope"`
}

type TagListParams struct {
	Cwd string `json:"cwd,omitempty"`
}

type TagListRemoteParams struct {
	Cwd    string `json:"cwd,omitempty"`
	Remote string `json:"remote"`
	RunID  string `json:"runId,omitempty"`
}

type TagCreateParams struct {
	Cwd     string `json:"cwd,omitempty"`
	Name    string `json:"name"`
	Ref     string `json:"ref,omitempty"`
	Message string `json:"message,omitempty"`
}

type TagDeleteParams struct {
	Cwd  string `json:"cwd,omitempty"`
	Name string `json:"name"`
}

type TagDeleteRemoteParams struct {
	Cwd    string `json:"cwd,omitempty"`
	Remote string `json:"remote"`
	Name   string `json:"name"`
	RunID  string `json:"runId,omitempty"`
}

type TagPushParams struct {
	Cwd    string `json:"cwd,omitempty"`
	Remote string `json:"remote,omitempty"`
	RunID  string `json:"runId,omitempty"`
}

const (
	tagFieldSep  = "\x1f"
	tagRecordSep = "\x1e"
	tagFormat    = "%(refname:short)\x1f%(objectname)\x1f%(*objectname)\x1f%(objecttype)\x1f%(taggerdate:unix)\x1f%(contents:subject)\x1e"
)

func (s *Service) TagList(ctx context.Context, raw json.RawMessage) (any, error) {
	var p TagListParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, proto.ProtocolError("git.tag.list params must be an object")
		}
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.tag.list cwd must not contain NUL")
	}

	args := []string{"for-each-ref", fmt.Sprintf("--format=%s", tagFormat), "refs/tags"}
	cmd, err := s.command(ctx, args, p.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	stdout, stderr, code, fatal := runCapturedCommand(ctx, cmd)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		stderrStr := stderr
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, classifiedFailure(kind, msg)
	}

	tags := parseTagList(stdout)
	return tags, nil
}

func (s *Service) TagListRemote(ctx context.Context, raw json.RawMessage) (any, error) {
	var p TagListRemoteParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.tag.listRemote params must include remote")
	}
	remote, err := normalizeRequiredRemoteName(p.Remote)
	if err != nil {
		return nil, err
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.tag.listRemote cwd must not contain NUL")
	}

	args := []string{"ls-remote", "--tags", "--refs", remote}
	ctx, done, err := s.startRun(ctx, p.RunID)
	if err != nil {
		return nil, err
	}
	defer done()

	cmd, err := s.command(ctx, args, p.Cwd, nil, true)
	if err != nil {
		return nil, err
	}
	stdout, stderr, code, fatal := runCapturedCommand(ctx, cmd)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		stderrStr := stderr
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, classifiedFailure(kind, msg)
	}

	tags := parseRemoteTagList(stdout, remote)
	return tags, nil
}

func (s *Service) TagCreate(ctx context.Context, raw json.RawMessage) (any, error) {
	var p TagCreateParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.tag.create params must include name")
	}
	tagName, err := normalizeRequiredTagName(p.Name)
	if err != nil {
		return nil, err
	}
	targetRef := normalizeTagTargetRef(p.Ref)
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.tag.create cwd must not contain NUL")
	}

	if err := s.assertTagTargetExists(ctx, p.Cwd, targetRef); err != nil {
		return nil, err
	}

	message := strings.TrimSpace(p.Message)
	var args []string
	if message != "" {
		args = []string{"tag", "-a", tagName, targetRef, "-m", message}
	} else {
		args = []string{"tag", tagName, targetRef}
	}

	cmd, err := s.command(ctx, args, p.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	var stderr gitStderr
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(cmd.ProcessState, err)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, classifiedFailure(kind, msg)
	}
	return nil, nil
}

func (s *Service) TagDelete(ctx context.Context, raw json.RawMessage) (any, error) {
	var p TagDeleteParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.tag.delete params must include name")
	}
	tagName, err := normalizeRequiredTagName(p.Name)
	if err != nil {
		return nil, err
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.tag.delete cwd must not contain NUL")
	}

	args := []string{"tag", "-d", tagName}
	cmd, err := s.command(ctx, args, p.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	var stderr gitStderr
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(cmd.ProcessState, err)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, classifiedFailure(kind, msg)
	}
	return nil, nil
}

func (s *Service) TagDeleteRemote(ctx context.Context, raw json.RawMessage) (any, error) {
	var p TagDeleteRemoteParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.tag.deleteRemote params must include remote and name")
	}
	remote, err := normalizeRequiredRemoteName(p.Remote)
	if err != nil {
		return nil, err
	}
	tagName, err := normalizeRequiredTagName(p.Name)
	if err != nil {
		return nil, err
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.tag.deleteRemote cwd must not contain NUL")
	}

	args := []string{"push", remote, fmt.Sprintf(":refs/tags/%s", tagName)}
	ctx, done, err := s.startRun(ctx, p.RunID)
	if err != nil {
		return nil, err
	}
	defer done()

	cmd, err := s.command(ctx, args, p.Cwd, nil, true)
	if err != nil {
		return nil, err
	}
	var stderr gitStderr
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(cmd.ProcessState, err)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, classifiedFailure(kind, msg)
	}
	return nil, nil
}

func (s *Service) TagPush(ctx context.Context, raw json.RawMessage) (any, error) {
	var p TagPushParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, proto.ProtocolError("git.tag.push params must be an object")
		}
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.tag.push cwd must not contain NUL")
	}

	trimmed := strings.TrimSpace(p.Remote)
	var args []string
	if trimmed != "" {
		args = []string{"push", trimmed, "--tags"}
	} else {
		args = []string{"push", "--tags"}
	}

	ctx, done, err := s.startRun(ctx, p.RunID)
	if err != nil {
		return nil, err
	}
	defer done()

	cmd, err := s.command(ctx, args, p.Cwd, nil, true)
	if err != nil {
		return nil, err
	}
	var stderr gitStderr
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	code, fatal := gitExitCode(cmd.ProcessState, err)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, classifiedFailure(kind, msg)
	}
	return nil, nil
}

func parseTagList(stdout string) []Tag {
	tags := make([]Tag, 0)
	for _, rawRecord := range strings.Split(stdout, tagRecordSep) {
		record := strings.TrimLeft(rawRecord, "\r\n")
		if strings.TrimSpace(record) == "" {
			continue
		}

		fields := strings.Split(record, tagFieldSep)
		if len(fields) < 6 {
			continue
		}
		name := strings.TrimSpace(fields[0])
		objectSHA := strings.TrimSpace(fields[1])
		dereferencedSHA := strings.TrimSpace(fields[2])
		objectType := strings.TrimSpace(fields[3])
		taggerDate := strings.TrimSpace(fields[4])
		subject := strings.TrimSpace(fields[5])

		if name == "" || objectSHA == "" {
			continue
		}

		isAnnotated := objectType == "tag"
		targetSHA := objectSHA
		if isAnnotated && dereferencedSHA != "" {
			targetSHA = dereferencedSHA
		}

		tag := Tag{
			Name: name,
			SHA:  targetSHA,
		}
		if isAnnotated {
			tag.Type = "annotated"
			if subject != "" {
				tag.Message = &subject
			}
			if ts := parseTaggerDate(taggerDate); ts != nil {
				tag.TaggerDate = ts
			}
		} else {
			tag.Type = "lightweight"
		}
		tags = append(tags, tag)
	}
	return tags
}

func parseRemoteTagList(stdout string, remote string) []RemoteTag {
	tags := make([]RemoteTag, 0)
	for _, rawLine := range strings.Split(stdout, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		sha := parts[0]
		ref := parts[1]
		if !strings.HasPrefix(ref, "refs/tags/") {
			continue
		}
		name := strings.TrimPrefix(ref, "refs/tags/")
		if name == "" || strings.HasSuffix(name, "^{}") {
			continue
		}
		tags = append(tags, RemoteTag{
			Remote: remote,
			Name:   name,
			SHA:    sha,
			Scope:  "remote",
		})
	}
	return tags
}

func normalizeRequiredTagName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || strings.HasPrefix(trimmed, "-") {
		return "", proto.CodedError{Code: proto.CodeRequestFailed, Msg: "tag-name-invalid: Tag name is invalid."}
	}
	return trimmed, nil
}

func normalizeRequiredRemoteName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || strings.HasPrefix(trimmed, "-") || strings.ContainsAny(trimmed, " \t\r\n") {
		return "", proto.CodedError{Code: proto.CodeRequestFailed, Msg: "remote-name-invalid: Remote name is invalid."}
	}
	return trimmed, nil
}

func normalizeTagTargetRef(ref string) string {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" {
		return "HEAD"
	}
	return trimmed
}

func parseTaggerDate(value string) *int64 {
	if value == "" {
		return nil
	}
	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil || seconds < 0 {
		return nil
	}
	ms := int64(seconds * 1000)
	return &ms
}

func (s *Service) assertTagTargetExists(ctx context.Context, cwd string, ref string) error {
	args := []string{"rev-parse", "--verify", ref + "^{object}"}
	cmd, err := s.command(ctx, args, cwd, nil, false)
	if err != nil {
		return err
	}
	var stderr gitStderr
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	code, fatal := gitExitCode(cmd.ProcessState, err)
	if fatal != nil {
		return fatal
	}
	if code != 0 {
		return proto.CodedError{
			Code: proto.CodeRequestFailed,
			Msg:  fmt.Sprintf("ref-not-found: Reference '%s' was not found.", ref),
		}
	}
	return nil
}
