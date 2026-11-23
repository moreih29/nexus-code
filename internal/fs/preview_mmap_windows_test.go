package fs

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/nexus-code/nexus-code/internal/proto"
	"golang.org/x/sys/windows"
)

func TestPreviewDetectsMappedWriteAfterWriterHandleCloses(t *testing.T) {
	s, root := previewFixture(t)
	const name = "mapped.bin"
	file, err := os.OpenFile(filepath.Join(root, name), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := file.Truncate(previewProofBlockBytes); err != nil {
		t.Fatal(err)
	}
	mapping, err := windows.CreateFileMapping(windows.Handle(file.Fd()), nil, windows.PAGE_READWRITE, 0, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(mapping)
	view, err := windows.MapViewOfFile(mapping, windows.FILE_MAP_WRITE, 0, 0, previewProofBlockBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.UnmapViewOfFile(view)
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	writeMappedByte := func(value byte) {
		t.Helper()
		if err := windows.WriteProcessMemory(windows.CurrentProcess(), view, &value, 1, nil); err != nil {
			t.Fatal(err)
		}
	}
	writeMappedByte(1)
	params := previewParams{RelPath: name, Length: 1, VersionScope: "workspace"}
	initial, err := previewRequest(t, s, params)
	if err != nil || initial.Base64 != "AQ==" {
		t.Fatalf("first mapped read: %+v %v", initial, err)
	}
	if initial.Version == "" {
		t.Skip("filesystem does not issue preview versions")
	}
	writeMappedByte(2)
	params.IfVersion = initial.Version
	edited, err := previewRequest(t, s, params)
	if err != nil || edited.Kind != "ok" || edited.Base64 != "Ag==" || edited.Version == initial.Version {
		t.Fatalf("changed mapped read: %+v %v", edited, err)
	}
	params.IfVersion = ""
	params.RequireVersion = initial.Version
	if _, err := previewRequest(t, s, params); proto.ErrorCode(err) != CodeStale {
		t.Fatalf("pin missed a changed block in a writable mapping: %v", err)
	}
}
