package git

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

// RemoteAddParams carries cwd, name, and url for remote add.
type RemoteAddParams struct {
	Cwd  string `json:"cwd,omitempty"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

// RemoteRemoveParams carries cwd and name for remote remove.
type RemoteRemoveParams struct {
	Cwd  string `json:"cwd,omitempty"`
	Name string `json:"name"`
}

// RemoteAdd executes `git remote add <name> <url>`. URL validation is
// performed on the client (TS) side before the RPC is issued; Go passes
// the URL directly to git and classifies any resulting errors.
func (s *Service) RemoteAdd(ctx context.Context, raw json.RawMessage) (any, error) {
	var p RemoteAddParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.remote.add params must include name and url")
	}
	remoteName, err := normalizeRequiredRemoteName(p.Name)
	if err != nil {
		return nil, err
	}
	url := strings.TrimSpace(p.URL)
	if url == "" {
		return nil, proto.ProtocolError("git.remote.add url is required")
	}
	if strings.Contains(url, "\x00") {
		return nil, proto.ProtocolError("git.remote.add url must not contain NUL")
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.remote.add cwd must not contain NUL")
	}

	args := []string{"remote", "add", remoteName, url}
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

// RemoteRemove executes `git remote remove <name>`. "No such remote" errors are
// classified as KindRemoteNotFound via the stderr classifier.
func (s *Service) RemoteRemove(ctx context.Context, raw json.RawMessage) (any, error) {
	var p RemoteRemoveParams
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return nil, proto.ProtocolError("git.remote.remove params must include name")
	}
	remoteName, err := normalizeRequiredRemoteName(p.Name)
	if err != nil {
		return nil, err
	}
	if strings.Contains(p.Cwd, "\x00") {
		return nil, proto.ProtocolError("git.remote.remove cwd must not contain NUL")
	}

	args := []string{"remote", "remove", remoteName}
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
		// Map both classified remote-not-found and "no such remote" stderr patterns
		// to a stable error message matching the TS normalizeRemoteRemoveError behavior.
		if kind == KindRemoteNotFound || isNoSuchRemoteStderr(stderrStr) {
			return nil, proto.CodedError{
				Code: proto.CodeRequestFailed,
				Msg:  MessageForKind(KindRemoteNotFound, MessageContext{Args: args}),
			}
		}
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: msg}
	}
	return nil, nil
}

// isNoSuchRemoteStderr detects "No such remote" patterns not yet in the
// Classify table, mirroring the TS normalizeRemoteRemoveError check.
func isNoSuchRemoteStderr(stderr string) bool {
	lower := strings.ToLower(stderr)
	return strings.Contains(lower, "no such remote")
}
