// Package cliclient is `agent cli <args>`, the program behind the nexus
// command in the app's terminals. It hands its arguments to the app through
// the agent's hook socket and prints what the app answers; the commands
// themselves, their parsing and their help live in the app.
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
	"time"
)

// The terminal tells the client where the app is and who is asking.
const (
	envAgentSocket = "NEXUS_AGENT_SOCKET"
	envHookToken   = "NEXUS_HOOK_TOKEN"
	envWorkspaceID = "NEXUS_WORKSPACE_ID"
	envTabID       = "NEXUS_TAB_ID"
)

// clientTimeout bounds a request the app never answers, a little past the
// server's own deadline.
const clientTimeout = 36 * time.Minute

// maxResponseBytes bounds one answer; a page screenshot is the largest.
const maxResponseBytes = 64 * 1024 * 1024

// maxStdinBytes bounds the text read for a "-" argument.
const maxStdinBytes = 1024 * 1024

// request is what the app is asked. Field names match CliInvocationSchema
// in src/shared/cli/protocol.ts.
type request struct {
	Argv    []string `json:"argv"`
	Cwd     string   `json:"cwd"`
	TempDir string   `json:"tempDir"`
	Stdin   *string  `json:"stdin,omitempty"`
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

// result is the app's answer. Field names match CliResultSchema in
// src/shared/cli/protocol.ts.
type result struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
	Files    []file `json:"files,omitempty"`
}

// file is one file the command makes on this host, such as a screenshot.
type file struct {
	Path   string `json:"path"`
	Base64 string `json:"base64"`
}

// Run is `agent cli <args>` and returns the exit code.
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
	if slices.Contains(args, "-") {
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
	_, _ = io.WriteString(stdout, res.Stdout)
	_, _ = io.WriteString(stderr, res.Stderr)
	return res.ExitCode
}

// send asks the app and waits for its answer.
func send(socketPath string, req wireRequest) (*result, error) {
	conn, err := net.DialTimeout("unix", socketPath, 5*time.Second)
	if err != nil {
		return nil, errors.New("NexusCode is not reachable from this terminal")
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

// writeFile writes one file the app made, where the app said.
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
