// Spike Go agent — fs.readdir only, NDJSON over stdin/stdout.
// Goal: prove a single static Go binary can speak our NDJSON protocol.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// --- Wire types (must match TS contract on the client side) -----------------

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type response struct {
	ID     string      `json:"id"`
	Result interface{} `json:"result,omitempty"`
	Error  *errorBody  `json:"error,omitempty"`
}

type dirEntry struct {
	Name string `json:"name"`
	Type string `json:"type"` // "file" | "dir" | "symlink"
}

type readdirParams struct {
	RelPath string `json:"relPath"`
}

// --- Entry ------------------------------------------------------------------

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: agent <rootPath>")
		os.Exit(2)
	}
	rootPath := os.Args[1]

	// Mirror the TS agent's ready frame.
	writeFrame(map[string]string{"type": "ready"})

	scanner := bufio.NewScanner(os.Stdin)
	// Allow large NDJSON lines (default is 64KB).
	scanner.Buffer(make([]byte, 0, 1<<16), 16<<20)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		handleLine(rootPath, line)
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "stdin scan error:", err)
		os.Exit(1)
	}
}

// --- Dispatch ---------------------------------------------------------------

func handleLine(rootPath string, line []byte) {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		writeFrame(response{
			ID: "",
			Error: &errorBody{
				Code:    "agent.protocol-error",
				Message: "invalid NDJSON: " + err.Error(),
			},
		})
		return
	}

	switch req.Method {
	case "fs.readdir":
		var p readdirParams
		if err := json.Unmarshal(req.Params, &p); err != nil {
			respondError(req.ID, "agent.protocol-error", err.Error())
			return
		}
		entries, err := readdir(rootPath, p.RelPath)
		if err != nil {
			respondError(req.ID, "fs.error", err.Error())
			return
		}
		writeFrame(response{ID: req.ID, Result: entries})

	default:
		respondError(req.ID, "agent.method-not-supported", "method not supported: "+req.Method)
	}
}

// --- fs.readdir core --------------------------------------------------------

func readdir(rootPath, relPath string) ([]dirEntry, error) {
	abs, err := resolveSafe(rootPath, relPath)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	out := make([]dirEntry, 0, len(entries))
	for _, e := range entries {
		if isHiddenName(e.Name()) {
			continue
		}
		out = append(out, dirEntry{Name: e.Name(), Type: dirEntryType(e)})
	}
	return out, nil
}

func dirEntryType(e fs.DirEntry) string {
	switch {
	case e.Type()&fs.ModeSymlink != 0:
		return "symlink"
	case e.IsDir():
		return "dir"
	default:
		return "file"
	}
}

func isHiddenName(name string) bool {
	// Mirror TS isHiddenName behavior — leading-dot only.
	return strings.HasPrefix(name, ".")
}

// resolveSafe mirrors the workspace-membership guard from the TS side.
func resolveSafe(rootPath, relPath string) (string, error) {
	if relPath == "" {
		relPath = "."
	}
	abs := filepath.Join(rootPath, relPath)
	abs = filepath.Clean(abs)
	root := filepath.Clean(rootPath)
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return "", err
	}
	if rel == "." || rel == "" {
		return abs, nil
	}
	if strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", fmt.Errorf("path escapes workspace root")
	}
	return abs, nil
}

// --- Frame writer -----------------------------------------------------------

func writeFrame(v interface{}) {
	enc := json.NewEncoder(os.Stdout)
	// json.Encoder.Encode appends "\n" — matches NDJSON.
	if err := enc.Encode(v); err != nil {
		fmt.Fprintln(os.Stderr, "frame write error:", err)
	}
}

func respondError(id, code, message string) {
	writeFrame(response{ID: id, Error: &errorBody{Code: code, Message: message}})
}
