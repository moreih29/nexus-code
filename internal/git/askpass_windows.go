//go:build windows

package git

import (
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// packageAlias is the App Execution Alias the MSIX package declares for the
// agent (build/appx-manifest.cjs).
const packageAlias = "nexuscode-agent.exe"

var procGetCurrentPackageFamilyName = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetCurrentPackageFamilyName")

// askpassHelperPath returns the program git starts as the askpass helper:
// this executable, or, when it runs from an MSIX package, the package's alias
// for it. Only a process with the package's identity may run the package's
// files, and git, which runs from outside the package, has none; starting
// the alias gives the helper that identity.
func askpassHelperPath() (string, error) {
	family, ok := packageFamilyName()
	if !ok {
		return os.Executable()
	}
	localAppData, err := windows.KnownFolderPath(windows.FOLDERID_LocalAppData, 0)
	if err != nil {
		return "", err
	}
	return filepath.Join(localAppData, "Microsoft", "WindowsApps", family, packageAlias), nil
}

// packageFamilyName returns the family name of the MSIX package this process
// runs from, if it runs from one.
func packageFamilyName() (string, bool) {
	// PACKAGE_FAMILY_NAME_MAX_LENGTH, and the terminating NUL.
	name := make([]uint16, 65)
	length := uint32(len(name))
	// APPMODEL_ERROR_NO_PACKAGE when the process has no package identity.
	rc, _, _ := procGetCurrentPackageFamilyName.Call(uintptr(unsafe.Pointer(&length)), uintptr(unsafe.Pointer(&name[0])))
	if rc != 0 {
		return "", false
	}
	return windows.UTF16ToString(name), true
}
