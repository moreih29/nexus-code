package agentpaths

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

func shortSocketDir(string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("agentpaths: cannot determine home directory: %w", err)
	}
	return filepath.Join(home, rootDirName, "sockets"), nil
}

func EnsurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("agentpaths: cannot create directory %q: %w", dir, err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	attrs, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok || !info.IsDir() || attrs.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return notPrivateDir(dir)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	if trusted, err := ownerTrusted(dir, user.User.Sid); err != nil {
		return err
	} else if !trusted {
		return notPrivateDir(dir)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;GA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("agentpaths: cannot restrict socket directory %q to the current user: %w", dir, err)
	}
	return nil
}

func ownerTrusted(dir string, user *windows.SID) (bool, error) {
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return false, err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return false, err
	}
	if owner.Equals(user) {
		return true, nil
	}
	for _, kind := range []windows.WELL_KNOWN_SID_TYPE{windows.WinBuiltinAdministratorsSid, windows.WinLocalSystemSid} {
		sid, err := windows.CreateWellKnownSid(kind)
		if err != nil {
			return false, err
		}
		if owner.Equals(sid) {
			return true, nil
		}
	}
	return false, nil
}

func notPrivateDir(dir string) error {
	return fmt.Errorf("agentpaths: socket directory %q must be a real directory owned by the current user", dir)
}
