package git

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/nexus-code/nexus-code/internal/proto"
)

type RemoteAddParams struct {
	Cwd  string `json:"cwd,omitempty"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

type RemoteRemoveParams struct {
	Cwd  string `json:"cwd,omitempty"`
	Name string `json:"name"`
}

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
		if kind == KindRemoteNotFound || isNoSuchRemoteStderr(stderrStr) {
			return nil, classifiedFailure(KindRemoteNotFound, MessageForKind(KindRemoteNotFound, MessageContext{Args: args}))
		}
		msg := MessageForKind(kind, MessageContext{Stderr: stderrStr, Args: args, ExitCode: &code})
		return nil, classifiedFailure(kind, msg)
	}
	return nil, nil
}

func isNoSuchRemoteStderr(stderr string) bool {
	lower := strings.ToLower(stderr)
	return strings.Contains(lower, "no such remote")
}
