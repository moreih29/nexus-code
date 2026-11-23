//go:build windows

package msix

import (
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32                        = windows.NewLazySystemDLL("kernel32.dll")
	procGetCurrentPackageFamilyName = kernel32.NewProc("GetCurrentPackageFamilyName")
	procGetCurrentPackagePath       = kernel32.NewProc("GetCurrentPackagePath")
)

func AgentAlias() (string, bool) {
	family, ok := current(procGetCurrentPackageFamilyName, 65)
	if !ok {
		return "", false
	}
	localAppData, err := windows.KnownFolderPath(windows.FOLDERID_LocalAppData, 0)
	if err != nil {
		return "", false
	}
	return filepath.Join(localAppData, "Microsoft", "WindowsApps", family, agentAlias), true
}

func InstallDir() (string, bool) {
	return current(procGetCurrentPackagePath, windows.MAX_LONG_PATH)
}

func current(proc *windows.LazyProc, size int) (string, bool) {
	value := make([]uint16, size)
	length := uint32(len(value))
	rc, _, _ := proc.Call(uintptr(unsafe.Pointer(&length)), uintptr(unsafe.Pointer(&value[0])))
	if rc != 0 {
		return "", false
	}
	return windows.UTF16ToString(value), true
}
