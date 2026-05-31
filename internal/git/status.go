package git

import (
	"context"
	"encoding/json"
	"strings"
	"sync"

	"github.com/nexus-code/nexus-code/internal/proto"
)

type StatusParams struct {
	Cwd       string `json:"cwd,omitempty"`
	Untracked string `json:"untracked,omitempty"`
	Renames   *bool  `json:"renames,omitempty"`
	Ignored   bool   `json:"ignored,omitempty"`
}

type statusSubcalls struct {
	stdout  []byte
	remotes []string
	stashes int
	tags    int
	gitDir  string
}

// Status returns a bundled GitStatus snapshot from host-local git subcalls.
func (s *Service) Status(ctx context.Context, raw json.RawMessage) (any, error) {
	params, err := parseStatusParams(raw)
	if err != nil {
		return nil, err
	}

	subcalls, err := s.runStatusSubcalls(ctx, params)
	if err != nil {
		return nil, err
	}
	status, err := ParsePorcelainV2(subcalls.stdout)
	if err != nil {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: err.Error()}
	}

	status.Capabilities.Remotes = subcalls.remotes
	status.Capabilities.StashCount = subcalls.stashes
	status.Capabilities.TagCount = subcalls.tags

	metadata, err := s.statusMetadata(subcalls.gitDir, len(status.Merge))
	if err != nil {
		return nil, err
	}
	status.OperationState = metadata.OperationState
	status.LastFetchedAt = metadata.LastFetchedAt
	return status, nil
}

func parseStatusParams(raw json.RawMessage) (StatusParams, error) {
	params := StatusParams{Untracked: "all"}
	if len(raw) != 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return params, proto.ProtocolError("git.status params must be an object")
		}
	}
	switch params.Untracked {
	case "", "all":
		params.Untracked = "all"
	case "normal", "no":
	default:
		return params, proto.ProtocolError("git.status untracked must be all, normal, or no")
	}
	return params, nil
}

func (s *Service) runStatusSubcalls(ctx context.Context, params StatusParams) (statusSubcalls, error) {
	var result statusSubcalls
	var firstErr error
	var mu sync.Mutex
	var wg sync.WaitGroup

	run := func(assign func([]byte), args ...string) {
		defer wg.Done()
		out, err := s.statusGitOutput(ctx, params.Cwd, args...)
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			return
		}
		assign(out)
	}

	wg.Add(5)
	go run(func(out []byte) { result.stdout = out }, statusArgs(params)...)
	go run(func(out []byte) { result.remotes = parseNonemptyLines(string(out)) }, "remote")
	go run(func(out []byte) { result.stashes = countNonemptyLines(string(out)) }, "stash", "list", "--format=%H")
	go run(func(out []byte) { result.tags = countNonemptyLines(string(out)) }, "tag", "--list")
	go run(func(out []byte) { result.gitDir = strings.TrimSpace(string(out)) }, "rev-parse", "--absolute-git-dir")
	wg.Wait()

	if firstErr != nil {
		return result, firstErr
	}
	if result.gitDir == "" {
		return result, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git.status could not resolve git dir"}
	}
	return result, nil
}

func statusArgs(params StatusParams) []string {
	args := []string{"status", "--porcelain=v2", "-z", "-b", "--untracked-files=" + params.Untracked}
	if params.Renames == nil || *params.Renames {
		args = append(args, "--renames")
	} else {
		args = append(args, "--no-renames")
	}
	if params.Ignored {
		args = append(args, "--ignored")
	}
	return args
}

func (s *Service) statusGitOutput(ctx context.Context, cwd string, args ...string) ([]byte, error) {
	stdout, stderr, code, err := s.capture(ctx, cwd, args, false)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, gitError(args, stderr, code)
	}
	return []byte(stdout), nil
}

func (s *Service) statusMetadata(gitDir string, conflictCount int) (MetadataResult, error) {
	state, err := readOperationState(gitDir, conflictCount)
	if err != nil {
		return MetadataResult{}, err
	}
	fetched, err := readFetchHeadMtime(gitDir)
	if err != nil {
		return MetadataResult{}, err
	}
	return MetadataResult{OperationState: state, LastFetchedAt: fetched}, nil
}

func parseNonemptyLines(text string) []string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	values := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			values = append(values, line)
		}
	}
	return values
}

func countNonemptyLines(text string) int {
	return len(parseNonemptyLines(text))
}
