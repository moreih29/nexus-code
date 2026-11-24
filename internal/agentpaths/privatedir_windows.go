package agentpaths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func shortSocketDir(preferred string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("agentpaths: cannot determine home directory: %w", err)
	}
	return filepath.Join(home, rootDirName, "s", preferredHash(preferred)), nil
}

func EnsurePrivateDir(dir string) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return cannotCheck(dir, err)
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return fmt.Errorf("agentpaths: cannot create socket directory %q: %w", dir, err)
	}
	if err := createPrivateDir(dir, user.User.Sid); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return fmt.Errorf("agentpaths: cannot create socket directory %q: %w", dir, err)
	}
	private, err := onlyUserMayEnter(dir, user.User.Sid)
	if err != nil {
		return cannotCheck(dir, err)
	}
	if !private {
		return notPrivateDir(dir)
	}
	return nil
}

func FreshPrivateSocketDir(string) (string, error) {
	return "", fmt.Errorf("agentpaths: no other socket directory on Windows: %w", errors.ErrUnsupported)
}

func createPrivateDir(dir string, user *windows.SID) error {
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;GA;;;" + user.String() + ")")
	if err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	return windows.CreateDirectory(name, &sa)
}

func onlyUserMayEnter(dir string, user *windows.SID) (bool, error) {
	name, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return false, err
	}
	h, err := windows.CreateFile(name, windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return false, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 ||
		info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return false, nil
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false, err
	}
	if trusted, err := ownerTrusted(sd, user); err != nil || !trusted {
		return false, err
	}
	control, _, err := sd.Control()
	if err != nil {
		return false, err
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		return false, nil
	}
	if dacl, _, err := sd.DACL(); err != nil || dacl == nil {
		return false, nil
	}
	return daclAllowsOnly(sd.String(), user), nil
}

func ownerTrusted(sd *windows.SECURITY_DESCRIPTOR, user *windows.SID) (bool, error) {
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

func daclAllowsOnly(sddl string, user *windows.SID) bool {
	start := strings.Index(sddl, "D:")
	if start < 0 {
		return false
	}
	dacl := sddl[start+len("D:"):]
	open := strings.IndexByte(dacl, '(')
	if open < 0 || !strings.HasSuffix(dacl, ")") {
		return false
	}
	for _, ace := range strings.Split(dacl[open+1:len(dacl)-1], ")(") {
		fields := strings.Split(ace, ";")
		if len(fields) != 6 || fields[0] != "A" {
			return false
		}
		sid, err := windows.StringToSid(fields[5])
		if err != nil || !sid.Equals(user) {
			return false
		}
	}
	return true
}
