package chat

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func claudeProjectsDir(configDir string) string {
	if configDir == "" {
		return ""
	}
	projects := filepath.Join(configDir, "projects")
	if info, err := os.Stat(projects); err != nil || !info.IsDir() {
		return ""
	}
	return projects
}

func claudeProjectFolders(projects string) []string {
	if projects == "" {
		return nil
	}
	entries, err := os.ReadDir(projects)
	if err != nil {
		return nil
	}
	folders := make([]string, 0, len(entries))
	for _, entry := range entries {
		if folder := filepath.Join(projects, entry.Name()); realDir(folder) {
			folders = append(folders, folder)
		}
	}
	return folders
}

func claudeProjectFoldersFor(projects, cwd string) []string {
	if projects == "" {
		return nil
	}
	var folders []string
	for _, folder := range projectDirs(projects, cwd) {
		if realDir(folder) {
			folders = append(folders, folder)
		}
	}
	return folders
}

func claudeFile(path string) (os.FileInfo, bool) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, false
	}
	return info, true
}

func findClaudeSession(configDir, sessionID string) (string, os.FileInfo) {
	if !sessionIDPattern.MatchString(sessionID) {
		return "", nil
	}
	var paths []string
	for _, folder := range claudeProjectFolders(claudeProjectsDir(configDir)) {
		paths = append(paths, filepath.Join(folder, sessionID+".jsonl"))
	}
	return newestClaudeFile(paths)
}

func findSubagent(configDir, sessionID, agentID, toolUseID string) (string, os.FileInfo) {
	if !sessionIDPattern.MatchString(sessionID) || (agentID != "" && !agentIDPattern.MatchString(agentID)) {
		return "", nil
	}
	var folders []string
	for _, project := range claudeProjectFolders(claudeProjectsDir(configDir)) {
		session := filepath.Join(project, sessionID)
		folder := filepath.Join(session, "subagents")
		if realDir(session) && realDir(folder) {
			folders = append(folders, folder)
		}
	}
	if agentID != "" {
		paths := make([]string, 0, len(folders))
		for _, folder := range folders {
			paths = append(paths, filepath.Join(folder, "agent-"+agentID+".jsonl"))
		}
		if path, info := newestClaudeFile(paths); path != "" || toolUseID == "" {
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
	return newestClaudeFile(paths)
}

const subagentMetaCap = 64 * 1024

func subagentCallOf(path string) string {
	info, ok := claudeFile(path)
	if !ok {
		return ""
	}
	file, _, err := openFound(path, info)
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

func newestClaudeFile(paths []string) (string, os.FileInfo) {
	found := ""
	var foundInfo os.FileInfo
	for _, path := range paths {
		info, ok := claudeFile(path)
		if !ok {
			continue
		}
		if foundInfo == nil || info.ModTime().After(foundInfo.ModTime()) {
			found, foundInfo = path, info
		}
	}
	return found, foundInfo
}

var errNotFoundFile = errors.New("the file is not the one that was found")

func openFound(path string, want os.FileInfo) (*os.File, os.FileInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || (want != nil && !os.SameFile(want, info)) {
		file.Close()
		return nil, nil, errNotFoundFile
	}
	return file, info, nil
}
