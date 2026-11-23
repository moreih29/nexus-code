package agentrun

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

const staleLogRetention = 7 * 24 * time.Hour

func SweepStale(runDir, socketDir, ownWsID string) []string {
	entries, err := os.ReadDir(runDir)
	if err != nil {
		return nil
	}
	var removed []string
	seen := make(map[string]bool)
	for _, entry := range entries {
		name := entry.Name()
		ext := filepath.Ext(name)
		if ext != ".lock" && ext != ".sock" && ext != ".log" {
			continue
		}
		id := strings.TrimSuffix(name, ext)
		if !isWsID(id) || id == ownWsID || seen[id] {
			continue
		}
		seen[id] = true
		removed = append(removed, sweepWorkspace(runDir, socketDir, id)...)
	}
	return removed
}

func isWsID(s string) bool {
	if len(s) != 16 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func sweepWorkspace(runDir, socketDir, id string) []string {
	lockPath := filepath.Join(runDir, id+".lock")
	f, err := os.OpenFile(lockPath, os.O_RDWR, 0600)
	if err != nil {
		return nil
	}
	defer f.Close()
	if err := lockFile(f); err != nil {
		return nil
	}

	var removed []string
	sockPath := filepath.Join(socketDir, id+".sock")
	if err := os.Remove(sockPath); err == nil {
		removed = append(removed, sockPath)
	}
	authSockPath := filepath.Join(socketDir, id+".agent")
	if err := os.Remove(authSockPath); err == nil {
		removed = append(removed, authSockPath)
	}
	logPath := filepath.Join(runDir, id+".log")
	if fi, err := os.Stat(logPath); err == nil && time.Since(fi.ModTime()) > staleLogRetention {
		if err := os.Remove(logPath); err == nil {
			removed = append(removed, logPath)
		}
	}
	return removed
}

func CapLogSize(path string, maxBytes int64) bool {
	fi, err := os.Stat(path)
	if err != nil || fi.Size() <= maxBytes {
		return false
	}
	return os.Truncate(path, 0) == nil
}
