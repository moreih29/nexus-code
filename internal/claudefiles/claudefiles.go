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

func Open(projects, path string, want os.FileInfo) (*os.File, os.FileInfo, error) {
	root, rel, err := openRoot(projects, path)
	if err != nil {
		return nil, nil, err
	}
	defer root.Close()
	file, err := root.Open(rel)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || (want != nil && !os.SameFile(want, info)) || !realDirs(root, rel) || linked(file, info) {
		file.Close()
		return nil, nil, ErrNotFoundFile
	}
	return file, info, nil
}

func Remove(projects, path string) error {
	root, rel, err := openRoot(projects, path)
	if err != nil {
		return err
	}
	defer root.Close()
	if info, err := root.Lstat(rel); err != nil || !info.Mode().IsRegular() || !realDirs(root, rel) {
		return ErrNotFoundFile
	}
	return root.Remove(rel)
}

func RemoveAll(projects, path string) error {
	root, rel, err := openRoot(projects, path)
	if err != nil {
		return err
	}
	defer root.Close()
	if !realDirs(root, rel) {
		return ErrNotFoundFile
	}
	return root.RemoveAll(rel)
}

func openRoot(projects, path string) (*os.Root, string, error) {
	if projects == "" {
		return nil, "", ErrNotFoundFile
	}
	rel, err := filepath.Rel(projects, path)
	if err != nil || rel == "." || !filepath.IsLocal(rel) {
		return nil, "", ErrNotFoundFile
	}
	root, err := os.OpenRoot(projects)
	if err != nil {
		return nil, "", err
	}
	return root, rel, nil
}

func realDirs(root *os.Root, rel string) bool {
	for dir := filepath.Dir(rel); dir != "."; dir = filepath.Dir(dir) {
		info, err := root.Lstat(dir)
		if err != nil || !info.IsDir() {
			return false
		}
	}
	return true
}
