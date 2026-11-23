//go:build darwin || linux

package fs

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"github.com/nexus-code/nexus-code/internal/proto"
	"golang.org/x/sys/unix"
)

func TestPreviewDetectsAnAlreadyDirtyMappedWrite(t *testing.T) {
	s, root := previewFixture(t)
	const name = "mapped.bin"
	file, err := os.OpenFile(filepath.Join(root, name), os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	const size = 2 * previewProofBlockBytes
	if err := file.Truncate(size); err != nil {
		t.Fatal(err)
	}
	mapped, err := unix.Mmap(int(file.Fd()), 0, size, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_SHARED)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Munmap(mapped)
	mapped[0] = 1
	params := previewParams{RelPath: name, Length: 1, VersionScope: "workspace"}
	initial, err := previewRequest(t, s, params)
	if err != nil || initial.Base64 != base64.StdEncoding.EncodeToString([]byte{1}) {
		t.Fatalf("first mapped read: %+v %v", initial, err)
	}
	if initial.Version == "" {
		t.Skip("filesystem does not issue preview versions")
	}
	mapped[0] = 2
	params.IfVersion = initial.Version
	edited, err := previewRequest(t, s, params)
	if err != nil || edited.Kind != "ok" || edited.Base64 != base64.StdEncoding.EncodeToString([]byte{2}) ||
		edited.Version == initial.Version {
		t.Fatalf("changed mapped read: %+v %v", edited, err)
	}
	params.IfVersion = ""
	params.RequireVersion = initial.Version
	if _, err := previewRequest(t, s, params); proto.ErrorCode(err) != CodeStale {
		t.Fatalf("pin missed a changed block in a writable mapping: %v", err)
	}
	params.Offset = previewProofBlockBytes
	params.RequireVersion = edited.Version
	pin, err := previewRequest(t, s, params)
	if err != nil || pin.Version != edited.Version || pin.Base64 != "AA==" {
		t.Fatalf("second block: %+v %v", pin, err)
	}
}
