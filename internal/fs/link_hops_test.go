//go:build !windows

package fs

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestNetworkHopFindsALinkToAnAutomountPath(t *testing.T) {
	dir := t.TempDir()
	link := filepath.Join(dir, "a.png")
	if err := os.Symlink("/net/qa-none-462/a.png", link); err != nil {
		t.Fatal(err)
	}
	target, err := networkHop(link)
	if err != nil || target != "/net/qa-none-462/a.png" {
		t.Fatalf("networkHop = %q, %v", target, err)
	}
}

func TestNetworkHopFollowsRelativeAndChainedLinks(t *testing.T) {
	dir := t.TempDir()
	if err := os.Symlink("../../../../../../../../../../System/Volumes/Data/Network/qa", filepath.Join(dir, "far")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("far/x.txt", filepath.Join(dir, "near")); err != nil {
		t.Fatal(err)
	}
	target, err := networkHop(filepath.Join(dir, "near"))
	if err != nil || target != "/System/Volumes/Data/Network/qa" {
		t.Fatalf("networkHop = %q, %v", target, err)
	}
}

func TestNetworkHopFindsALinkedFolderOnTheWay(t *testing.T) {
	dir := t.TempDir()
	if err := os.Symlink("/NET/qa", filepath.Join(dir, "share")); err != nil {
		t.Fatal(err)
	}
	target, err := networkHop(filepath.Join(dir, "share", "sub", "a.txt"))
	if err != nil || target != "/NET/qa" {
		t.Fatalf("networkHop = %q, %v", target, err)
	}
}

func TestNetworkHopPassesLocalLinksAndMissingFiles(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real.txt")
	if err := os.WriteFile(real, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(dir, "local")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(dir, "local"), filepath.Join(dir, "missing", "a")} {
		if target, err := networkHop(path); err != nil || target != "" {
			t.Fatalf("networkHop(%q) = %q, %v", path, target, err)
		}
	}
}

func TestNetworkHopStopsALoop(t *testing.T) {
	dir := t.TempDir()
	if err := os.Symlink("b", filepath.Join(dir, "a")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("a", filepath.Join(dir, "b")); err != nil {
		t.Fatal(err)
	}
	if _, err := networkHop(filepath.Join(dir, "a")); !errors.Is(err, errTooManyLinks) {
		t.Fatalf("networkHop err = %v", err)
	}
}

func TestNetworkHopLeavesAnAskedNetworkPathAlone(t *testing.T) {
	if target, err := networkHop("/net/qa-none-462/a"); err != nil || target != "" {
		t.Fatalf("networkHop = %q, %v", target, err)
	}
}

func TestReadPreviewRefusesALinkToAnAutomountPath(t *testing.T) {
	s, _ := previewFixture(t)
	link := filepath.Join(t.TempDir(), "a.txt")
	if err := os.Symlink("/net/qa-none-462/a.txt", link); err != nil {
		t.Fatal(err)
	}
	_, err := previewRequest(t, s, previewParams{AbsolutePath: link, Length: 1})
	var fsErr FSError
	if !errors.As(err, &fsErr) || fsErr.Code != CodeOutOfWorkspace {
		t.Fatalf("ReadPreview err = %v", err)
	}
}
