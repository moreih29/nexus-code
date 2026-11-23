package claudefiles

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
)

var SessionIDPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$`)

func ProjectsDir(configDir string) string {
	if configDir == "" {
		return ""
	}
	projects := filepath.Join(configDir, "projects")
	if info, err := os.Stat(projects); err != nil || !info.IsDir() {
		return ""
	}
	return projects
}

func ProjectFolders(projects string) []string {
	if projects == "" {
		return nil
	}
	entries, err := os.ReadDir(projects)
	if err != nil {
		return nil
	}
	folders := make([]string, 0, len(entries))
	for _, entry := range entries {
		if folder := filepath.Join(projects, entry.Name()); RealDir(folder) {
			folders = append(folders, folder)
		}
	}
	return folders
}

func RealDir(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir()
}

func RegularFile(path string) (os.FileInfo, bool) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, false
	}
	return info, true
}

func Newest(paths []string) (string, os.FileInfo) {
	found := ""
	var foundInfo os.FileInfo
	for _, path := range paths {
		info, ok := RegularFile(path)
		if !ok {
			continue
		}
		if foundInfo == nil || info.ModTime().After(foundInfo.ModTime()) {
			found, foundInfo = path, info
		}
	}
	return found, foundInfo
}

func FindSession(configDir, sessionID string) (string, os.FileInfo) {
	if !SessionIDPattern.MatchString(sessionID) {
		return "", nil
	}
	var paths []string
	for _, folder := range ProjectFolders(ProjectsDir(configDir)) {
		paths = append(paths, filepath.Join(folder, sessionID+".jsonl"))
	}
	return Newest(paths)
}

var ErrNotFoundFile = errors.New("the file is not the one that was found")

func Open(path string, want os.FileInfo) (*os.File, os.FileInfo, error) {
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
		return nil, nil, ErrNotFoundFile
	}
	return file, info, nil
}
