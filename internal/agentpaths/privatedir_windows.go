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
	reason, err := whyOthersMayEnter(dir, user.User.Sid)
	if err != nil {
		return cannotCheck(dir, err)
	}
	if reason != "" {
		return notPrivateDir(dir, "%s", reason)
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

func whyOthersMayEnter(dir string, user *windows.SID) (string, error) {
	name, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(name, windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return "", err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return "it is a junction or another reparse point", nil
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return "it is not a directory", nil
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return "", err
	}
	owner, trusted, err := ownerTrusted(sd, user)
	if err != nil {
		return "", err
	}
	if !trusted {
		return "it is owned by " + owner.String(), nil
	}
	if dacl, _, err := sd.DACL(); err != nil || dacl == nil {
		return "it has no DACL, so everyone may open it", nil
	}
	control, _, err := sd.Control()
	if err != nil {
		return "", err
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		return "its DACL inherits entries from the parent folder", nil
	}
	return daclProblem(sd.String(), user), nil
}

func ownerTrusted(sd *windows.SECURITY_DESCRIPTOR, user *windows.SID) (*windows.SID, bool, error) {
	owner, _, err := sd.Owner()
	if err != nil {
		return nil, false, err
	}
	if owner.Equals(user) {
		return owner, true, nil
	}
	for _, kind := range []windows.WELL_KNOWN_SID_TYPE{windows.WinBuiltinAdministratorsSid, windows.WinLocalSystemSid} {
		sid, err := windows.CreateWellKnownSid(kind)
		if err != nil {
			return nil, false, err
		}
		if owner.Equals(sid) {
			return owner, true, nil
		}
	}
	return owner, false, nil
}

func daclProblem(sddl string, user *windows.SID) string {
	start := strings.Index(sddl, "D:")
	if start < 0 {
		return "its DACL is missing"
	}
	dacl := sddl[start+len("D:"):]
	open := strings.IndexByte(dacl, '(')
	if open < 0 || !strings.HasSuffix(dacl, ")") {
		return "its DACL has no entries"
	}
	for _, ace := range strings.Split(dacl[open+1:len(dacl)-1], ")(") {
		fields := strings.Split(ace, ";")
		if len(fields) == 6 && fields[0] == "A" {
			if sid, err := windows.StringToSid(fields[5]); err == nil && sid.Equals(user) {
				continue
			}
		}
		return "its DACL has an entry that is not an allow for the current user: (" + ace + ")"
	}
	return ""
}
