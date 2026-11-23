package cliclient

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"syscall"
	"time"
)

const (
	envAgentSocket = "NEXUS_AGENT_SOCKET"
	envHookToken   = "NEXUS_HOOK_TOKEN"
	envWorkspaceID = "NEXUS_WORKSPACE_ID"
	envTabID       = "NEXUS_TAB_ID"
	envMsysRoot    = "NEXUS_MSYS_ROOT"
)

const clientTimeout = 36 * time.Minute

const maxResponseBytes = 64 * 1024 * 1024

const maxStdinBytes = 1024 * 1024

const wsaeacces = 10013

type request struct {
	Argv     []string `json:"argv"`
	Cwd      string   `json:"cwd"`
	TempDir  string   `json:"tempDir"`
	Stdin    *string  `json:"stdin,omitempty"`
	MsysRoot *string  `json:"msysRoot,omitempty"`
}

type wireRequest struct {
	Type        string  `json:"type"`
	Token       string  `json:"token"`
	WorkspaceID string  `json:"workspaceId"`
	TabID       string  `json:"tabId"`
	Payload     request `json:"payload"`
}

type wireResponse struct {
	OK     bool    `json:"ok"`
	Result *result `json:"result,omitempty"`
	Error  string  `json:"error,omitempty"`
}

type result struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
	Files    []file `json:"files,omitempty"`
}

type file struct {
	Path   string `json:"path"`
	Base64 string `json:"base64"`
}

func Run(args []string) int {
	return run(args, os.Stdin, os.Stdout, os.Stderr)
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	socketPath := os.Getenv(envAgentSocket)
	token := os.Getenv(envHookToken)
	workspaceID := os.Getenv(envWorkspaceID)
	tabID := os.Getenv(envTabID)
	if socketPath == "" || token == "" || workspaceID == "" || tabID == "" {
		fmt.Fprintln(stderr, "nexus: run this in a NexusCode terminal")
		return 2
	}

	cwd, _ := os.Getwd()
	req := request{Argv: args, Cwd: cwd, TempDir: os.TempDir()}
	if root, ok := os.LookupEnv(envMsysRoot); ok {
		req.MsysRoot = &root
	}
	keyStdin := len(args) >= 3 && slices.Equal(args[:3], []string{"chat", "profiles", "add"}) &&
		slices.Contains(args[3:], "--key-file=-")
	if slices.Contains(args, "-") || keyStdin {
		data, err := io.ReadAll(io.LimitReader(stdin, maxStdinBytes+1))
		if err != nil {
			fmt.Fprintf(stderr, "nexus: reading stdin: %v\n", err)
			return 1
		}
		if len(data) > maxStdinBytes {
			fmt.Fprintf(stderr, "nexus: stdin is over %d bytes\n", maxStdinBytes)
			return 1
		}
		text := string(data)
		req.Stdin = &text
	}

	res, err := send(socketPath, wireRequest{
		Type:        "cli",
		Token:       token,
		WorkspaceID: workspaceID,
		TabID:       tabID,
		Payload:     req,
	})
	if err != nil {
		fmt.Fprintf(stderr, "nexus: %v\n", err)
		return 1
	}
	for _, f := range res.Files {
		if err := writeFile(f); err != nil {
			fmt.Fprintf(stderr, "nexus: %v\n", err)
			return 1
		}
	}
	if res.ExitCode == 0 && len(args) > 0 && args[0] == "agent-context" && req.Stdin != nil {
		var err error
		res.Stdout, err = claudeHookContext(*req.Stdin, res.Stdout)
		if err != nil {
			fmt.Fprintln(stderr, "nexus: could not save Claude's full instructions")
		}
	}
	_, _ = io.WriteString(stdout, res.Stdout)
	_, _ = io.WriteString(stderr, res.Stderr)
	return res.ExitCode
}

func send(socketPath string, req wireRequest) (*result, error) {
	conn, err := net.DialTimeout("unix", socketPath, 5*time.Second)
	if err != nil {
		return nil, dialError(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(clientTimeout))

	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return nil, fmt.Errorf("sending the request: %w", err)
	}

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), maxResponseBytes)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return nil, fmt.Errorf("reading the answer: %w", err)
		}
		return nil, errors.New("NexusCode closed the connection without an answer")
	}
	var resp wireResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		return nil, fmt.Errorf("reading the answer: %w", err)
	}
	if !resp.OK || resp.Result == nil {
		if resp.Error == "" {
			resp.Error = "NexusCode gave no answer"
		}
		return nil, errors.New(resp.Error)
	}
	return resp.Result, nil
}

func dialError(err error) error {
	reason := err.Error()
	var syscallErr *os.SyscallError
	if errors.As(err, &syscallErr) {
		reason = syscallErr.Error()
	}
	var errno syscall.Errno
	if errors.Is(err, os.ErrPermission) || (errors.As(err, &errno) && errno == wsaeacces) {
		return fmt.Errorf("not allowed to connect to NexusCode (%s). If this runs in a sandbox, run nexus outside it: an agent asks the user for approval", reason)
	}
	return fmt.Errorf("NexusCode is not reachable from this terminal (%s)", reason)
}

func writeFile(f file) error {
	data, err := base64.StdEncoding.DecodeString(f.Base64)
	if err != nil {
		return fmt.Errorf("decoding %s: %w", f.Path, err)
	}
	if dir := filepath.Dir(f.Path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(f.Path, data, 0o644)
}
