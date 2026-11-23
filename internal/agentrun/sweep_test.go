package agentrun

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func mkRunFiles(t *testing.T, dir, id string, logAge time.Duration) (lock, sock, log string) {
	t.Helper()
	lock = filepath.Join(dir, id+".lock")
	sock = filepath.Join(dir, id+".sock")
	log = filepath.Join(dir, id+".log")
	for _, p := range []string{lock, sock, log} {
		if err := os.WriteFile(p, nil, 0600); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}
	if logAge > 0 {
		old := time.Now().Add(-logAge)
		if err := os.Chtimes(log, old, old); err != nil {
			t.Fatalf("chtimes %s: %v", log, err)
		}
	}
	return lock, sock, log
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestSweepStaleRemovesDeadDaemonFiles(t *testing.T) {
	dir := t.TempDir()
	lock, sock, log := mkRunFiles(t, dir, "aaaaaaaaaaaaaaaa", staleLogRetention+time.Hour)

	removed := SweepStale(dir, dir, "1111111111111111")

	if exists(sock) {
		t.Error("dead daemon's socket should be removed")
	}
	if exists(log) {
		t.Error("dead daemon's over-retention log should be removed")
	}
	if !exists(lock) {
		t.Error("lock file must never be removed (unlink/recreate race)")
	}
	if len(removed) != 2 {
		t.Errorf("removed = %v, want sock+log", removed)
	}
}

func TestSweepStaleRemovesDeadDaemonAgentLink(t *testing.T) {
	dir := t.TempDir()
	mkRunFiles(t, dir, "aaaaaaaaaaaaaaaa", 0)
	link := filepath.Join(dir, "aaaaaaaaaaaaaaaa.agent")
	if err := os.Symlink(filepath.Join(dir, "gone"), link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	SweepStale(dir, dir, "1111111111111111")

	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Errorf("dead daemon's agent link should be removed (err=%v)", err)
	}
}

func TestSweepStaleKeepsRecentLog(t *testing.T) {
	dir := t.TempDir()
	_, sock, log := mkRunFiles(t, dir, "bbbbbbbbbbbbbbbb", time.Hour)

	SweepStale(dir, dir, "1111111111111111")

	if exists(sock) {
		t.Error("dead daemon's socket should be removed")
	}
	if !exists(log) {
		t.Error("recent log must be kept for post-mortem debugging")
	}
}

func TestSweepStaleSkipsLiveDaemon(t *testing.T) {
	dir := t.TempDir()
	lockPath, sock, log := mkRunFiles(t, dir, "cccccccccccccccc", staleLogRetention+time.Hour)

	held, err := TryLock(lockPath)
	if err != nil {
		t.Fatalf("TryLock: %v", err)
	}
	defer held.Unlock()

	removed := SweepStale(dir, dir, "1111111111111111")

	if !exists(sock) || !exists(log) {
		t.Error("live daemon's files must not be touched")
	}
	if len(removed) != 0 {
		t.Errorf("removed = %v, want none", removed)
	}
}

func TestSweepStaleSkipsOwnWorkspace(t *testing.T) {
	dir := t.TempDir()
	_, sock, _ := mkRunFiles(t, dir, "dddddddddddddddd", staleLogRetention+time.Hour)

	removed := SweepStale(dir, dir, "dddddddddddddddd")

	if !exists(sock) {
		t.Error("own workspace files must not be swept")
	}
	if len(removed) != 0 {
		t.Errorf("removed = %v, want none", removed)
	}
}

func TestSweepStaleSkipsWithoutLockFile(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "eeeeeeeeeeeeeeee.sock")
	if err := os.WriteFile(sock, nil, 0600); err != nil {
		t.Fatal(err)
	}

	SweepStale(dir, dir, "1111111111111111")

	if !exists(sock) {
		t.Error("unprovable liveness → socket must be kept")
	}
}

func TestSweepStaleIgnoresForeignNames(t *testing.T) {
	dir := t.TempDir()
	foreign := []string{
		"readme.txt",
		"short.sock",
		"AAAAAAAAAAAAAAAA.sock",
		"gggggggggggggggg.sock",
		"ffffffffffffffff.sock.bak",
	}
	for _, name := range foreign {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}

	SweepStale(dir, dir, "1111111111111111")

	for _, name := range foreign {
		if !exists(filepath.Join(dir, name)) {
			t.Errorf("foreign file %q must not be removed", name)
		}
	}
}
