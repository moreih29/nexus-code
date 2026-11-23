package chat

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/nexus-code/nexus-code/internal/claudefiles"
)

func claudeProjectFoldersFor(projects, cwd string) []string {
	if projects == "" {
		return nil
	}
	var folders []string
	for _, folder := range projectDirs(projects, cwd) {
		if claudefiles.RealDir(folder) {
			folders = append(folders, folder)
		}
	}
	return folders
}

func findSubagent(configDir, sessionID, agentID, toolUseID string) (string, os.FileInfo) {
	if !claudefiles.SessionIDPattern.MatchString(sessionID) || (agentID != "" && !agentIDPattern.MatchString(agentID)) {
		return "", nil
	}
	var folders []string
	for _, project := range claudefiles.ProjectFolders(claudefiles.ProjectsDir(configDir)) {
		session := filepath.Join(project, sessionID)
		folder := filepath.Join(session, "subagents")
		if claudefiles.RealDir(session) && claudefiles.RealDir(folder) {
			folders = append(folders, folder)
		}
	}
	if agentID != "" {
		paths := make([]string, 0, len(folders))
		for _, folder := range folders {
			paths = append(paths, filepath.Join(folder, "agent-"+agentID+".jsonl"))
		}
		if path, info := claudefiles.Newest(paths); path != "" || toolUseID == "" {
			return path, info
		}
	}
	if toolUseID == "" {
		return "", nil
	}
	var paths []string
	for _, folder := range folders {
		files, _ := os.ReadDir(folder)
		for _, file := range files {
			name := file.Name()
			if !strings.HasPrefix(name, "agent-") || !strings.HasSuffix(name, ".meta.json") {
				continue
			}
			meta := filepath.Join(folder, name)
			if subagentCallOf(meta) == toolUseID {
				paths = append(paths, strings.TrimSuffix(meta, ".meta.json")+".jsonl")
			}
		}
	}
	return claudefiles.Newest(paths)
}

const subagentMetaCap = 64 * 1024

func subagentCallOf(path string) string {
	info, ok := claudefiles.RegularFile(path)
	if !ok {
		return ""
	}
	file, _, err := claudefiles.Open(path, info)
	if err != nil {
		return ""
	}
	defer file.Close()
	var meta struct {
		ToolUseID string `json:"toolUseId"`
	}
	if json.NewDecoder(io.LimitReader(file, subagentMetaCap)).Decode(&meta) != nil {
		return ""
	}
	return meta.ToolUseID
}
