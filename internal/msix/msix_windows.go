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

// AgentAlias returns the path of the package's alias for the agent, when
// this process runs from an MSIX package.
func AgentAlias() (string, bool) {
	family, ok := current(procGetCurrentPackageFamilyName, 65) // PACKAGE_FAMILY_NAME_MAX_LENGTH + NUL
	if !ok {
		return "", false
	}
	localAppData, err := windows.KnownFolderPath(windows.FOLDERID_LocalAppData, 0)
	if err != nil {
		return "", false
	}
	return filepath.Join(localAppData, "Microsoft", "WindowsApps", family, agentAlias), true
}

// InstallDir returns the directory the MSIX package this process runs from
// is installed in.
func InstallDir() (string, bool) {
	return current(procGetCurrentPackagePath, windows.MAX_LONG_PATH)
}

// current calls one of the GetCurrentPackage* functions that write a string
// of at most size UTF-16 units. They fail with APPMODEL_ERROR_NO_PACKAGE in a
// process without a package identity.
func current(proc *windows.LazyProc, size int) (string, bool) {
	value := make([]uint16, size)
	length := uint32(len(value))
	rc, _, _ := proc.Call(uintptr(unsafe.Pointer(&length)), uintptr(unsafe.Pointer(&value[0])))
	if rc != 0 {
		return "", false
	}
	return windows.UTF16ToString(value), true
}
