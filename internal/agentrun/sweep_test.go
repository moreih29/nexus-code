package agentrun

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// mkRunFiles creates <id>.lock/.sock/.log in dir. logAge backdates the log's
// mtime so retention behavior can be exercised.
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

// TestSweepStaleRemovesDeadDaemonFiles: a foreign workspace whose lock is NOT
// held (daemon provably dead) loses its socket and its over-retention log,
// but keeps the lock file itself.
func TestSweepStaleRemovesDeadDaemonFiles(t *testing.T) {
	dir := t.TempDir()
	lock, sock, log := mkRunFiles(t, dir, "aaaaaaaaaaaaaaaa", staleLogRetention+time.Hour)

	removed := SweepStale(dir, "1111111111111111")

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

// TestSweepStaleKeepsRecentLog: a dead workspace's log inside the retention
// window survives — it is post-mortem evidence.
func TestSweepStaleKeepsRecentLog(t *testing.T) {
	dir := t.TempDir()
	_, sock, log := mkRunFiles(t, dir, "bbbbbbbbbbbbbbbb", time.Hour)

	SweepStale(dir, "1111111111111111")

	if exists(sock) {
		t.Error("dead daemon's socket should be removed")
	}
	if !exists(log) {
		t.Error("recent log must be kept for post-mortem debugging")
	}
}

// TestSweepStaleSkipsLiveDaemon: while another process (here: this test, via
// TryLock) holds the flock, nothing of that workspace is touched.
func TestSweepStaleSkipsLiveDaemon(t *testing.T) {
	dir := t.TempDir()
	lockPath, sock, log := mkRunFiles(t, dir, "cccccccccccccccc", staleLogRetention+time.Hour)

	held, err := TryLock(lockPath)
	if err != nil {
		t.Fatalf("TryLock: %v", err)
	}
	defer held.Unlock()

	removed := SweepStale(dir, "1111111111111111")

	if !exists(sock) || !exists(log) {
		t.Error("live daemon's files must not be touched")
	}
	if len(removed) != 0 {
		t.Errorf("removed = %v, want none", removed)
	}
}

// TestSweepStaleSkipsOwnWorkspace: the caller's own files are out of scope
// even when its lock would be acquirable in-process.
func TestSweepStaleSkipsOwnWorkspace(t *testing.T) {
	dir := t.TempDir()
	_, sock, _ := mkRunFiles(t, dir, "dddddddddddddddd", staleLogRetention+time.Hour)

	removed := SweepStale(dir, "dddddddddddddddd")

	if !exists(sock) {
		t.Error("own workspace files must not be swept")
	}
	if len(removed) != 0 {
		t.Errorf("removed = %v, want none", removed)
	}
}

// TestSweepStaleSkipsWithoutLockFile: a socket with no lock file cannot be
// probed for liveness, so it is left alone.
func TestSweepStaleSkipsWithoutLockFile(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "eeeeeeeeeeeeeeee.sock")
	if err := os.WriteFile(sock, nil, 0600); err != nil {
		t.Fatal(err)
	}

	SweepStale(dir, "1111111111111111")

	if !exists(sock) {
		t.Error("unprovable liveness → socket must be kept")
	}
}

// TestSweepStaleIgnoresForeignNames: files that do not match the
// <16-hex>.{lock,sock,log} layout are never agentrun's to delete.
func TestSweepStaleIgnoresForeignNames(t *testing.T) {
	dir := t.TempDir()
	foreign := []string{
		"readme.txt",
		"short.sock",                // id not 16 chars
		"AAAAAAAAAAAAAAAA.sock",     // uppercase — not our hex
		"gggggggggggggggg.sock",     // non-hex chars
		"ffffffffffffffff.sock.bak", // wrong extension
	}
	for _, name := range foreign {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}

	SweepStale(dir, "1111111111111111")

	for _, name := range foreign {
		if !exists(filepath.Join(dir, name)) {
			t.Errorf("foreign file %q must not be removed", name)
		}
	}
}

// TestCapLogSize: oversize log is truncated to zero; small log untouched;
// missing file is a no-op.
func TestCapLogSize(t *testing.T) {
	dir := t.TempDir()

	big := filepath.Join(dir, "big.log")
	if err := os.WriteFile(big, make([]byte, 2048), 0600); err != nil {
		t.Fatal(err)
	}
	if !CapLogSize(big, 1024) {
		t.Error("oversize log should be truncated")
	}
	if fi, _ := os.Stat(big); fi.Size() != 0 {
		t.Errorf("truncated size = %d, want 0", fi.Size())
	}

	small := filepath.Join(dir, "small.log")
	if err := os.WriteFile(small, make([]byte, 100), 0600); err != nil {
		t.Fatal(err)
	}
	if CapLogSize(small, 1024) {
		t.Error("under-cap log must not be truncated")
	}
	if fi, _ := os.Stat(small); fi.Size() != 100 {
		t.Errorf("small log size = %d, want 100", fi.Size())
	}

	if CapLogSize(filepath.Join(dir, "absent.log"), 1024) {
		t.Error("missing file must be a no-op")
	}
}
