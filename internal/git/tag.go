package git

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// Tag mirrors src/shared/types/git.ts TagSchema.
// Message and TaggerDate use pointers so they marshal to JSON null when absent.
type Tag struct {
	Name       string  `json:"name"`
	SHA        string  `json:"sha"`
	Message    *string `json:"message"`
	Type       string  `json:"type"`
	TaggerDate *int64  `json:"taggerDate"`
}

// RemoteTag mirrors src/shared/types/git.ts RemoteTagSchema.
type RemoteTag struct {
	Remote string `json:"remote"`
	Name   string `json:"name"`
	SHA    string `json:"sha"`
	Scope  string `json:"scope"`
}

// TagListParams carries optional cwd for tag list.
type TagListParams struct {
	Cwd string `json:"cwd,omitempty"`
}

// TagListRemoteParams carries cwd and remote name for remote tag listing.
type TagListRemoteParams struct {
	Cwd    string `json:"cwd,omitempty"`
	Remote string `json:"remote"`
}

// TagCreateParams carries tag creation options.
type TagCreateParams struct {
	Cwd     string `json:"cwd,omitempty"`
	Name    string `json:"name"`
	Ref     string `json:"ref,omitempty"`
	Message string `json:"message,omitempty"`
}

// TagDeleteParams carries cwd and tag name for local tag deletion.
type TagDeleteParams struct {
	Cwd  string `json:"cwd,omitempty"`
	Name string `json:"name"`
}

// TagDeleteRemoteParams carries cwd, remote, and tag name for remote tag deletion.
type TagDeleteRemoteParams struct {
	Cwd    string `json:"cwd,omitempty"`
	Remote string `json:"remote"`
	Name   string `json:"name"`
}

// TagPushParams carries optional cwd and optional remote for tag push.
type TagPushParams struct {
	Cwd    string `json:"cwd,omitempty"`
	Remote string `json:"remote,omitempty"`
}

const (
	tagFieldSep  = "\x1f"
	tagRecordSep = "\x1e"
	tagFormat    = "%(refname:short)\x1f%(objectname)\x1f%(*objectname)\x1f%(objecttype)\x1f%(taggerdate:unix)\x1f%(contents:subject)\x1e"
)

// TagList executes for-each-ref and returns parsed Tag records.
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
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}

	tags := parseTagList(stdout.String())
	return tags, nil
}

// TagListRemote executes ls-remote --tags --refs via the interactive (askpass)
// path and returns RemoteTag records.
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
	cmd, err := s.command(ctx, args, p.Cwd, nil, true)
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
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}

	tags := parseRemoteTagList(stdout.String(), remote)
	return tags, nil
}

// TagCreate creates a lightweight or annotated tag. It preflights the target ref
// so bad refs surface as ref-not-found rather than a version-dependent message.
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

	// Preflight: verify target ref exists and surface as ref-not-found if not.
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
	var stderr bytes.Buffer
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
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}
	return nil, nil
}

// TagDelete deletes one local tag.
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
	var stderr bytes.Buffer
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
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}
	return nil, nil
}

// TagDeleteRemote deletes one tag from a remote using an interactive (askpass) push.
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
	cmd, err := s.command(ctx, args, p.Cwd, nil, true)
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
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
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}
	return nil, nil
}

// TagPush pushes all local tags to the configured upstream or a named remote
// using an interactive (askpass) path.
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

	cmd, err := s.command(ctx, args, p.Cwd, nil, true)
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
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
		stderrStr := stderr.String()
		kind := Classify(stderrStr)
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}
	return nil, nil
}

// parseTagList parses for-each-ref output into Tag records.
// Fields are separated by \x1f; records by \x1e.
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

// parseRemoteTagList parses ls-remote --tags --refs output into RemoteTag records.
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

// normalizeRequiredTagName validates and trims a tag name.
func normalizeRequiredTagName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || strings.HasPrefix(trimmed, "-") {
		return "", proto.CodedError{Code: proto.CodeRequestFailed, Msg: "tag-name-invalid: Tag name is invalid."}
	}
	return trimmed, nil
}

// normalizeRequiredRemoteName validates and trims a remote name.
func normalizeRequiredRemoteName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || strings.HasPrefix(trimmed, "-") || strings.ContainsAny(trimmed, " \t\r\n") {
		return "", proto.CodedError{Code: proto.CodeRequestFailed, Msg: "remote-name-invalid: Remote name is invalid."}
	}
	return trimmed, nil
}

// normalizeTagTargetRef resolves the tag target, defaulting to HEAD.
func normalizeTagTargetRef(ref string) string {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" {
		return "HEAD"
	}
	return trimmed
}

// parseTaggerDate converts Git's taggerdate unix field to epoch milliseconds.
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

// assertTagTargetExists runs rev-parse to verify the target ref before tag creation.
// Failures are remapped to ref-not-found.
func (s *Service) assertTagTargetExists(ctx context.Context, cwd string, ref string) error {
	args := []string{"rev-parse", "--verify", ref + "^{object}"}
	cmd, err := s.command(ctx, args, cwd, nil, false)
	if err != nil {
		return err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	err = cmd.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	code, fatal := gitExitCode(err)
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
