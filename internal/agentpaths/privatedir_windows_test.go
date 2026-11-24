package agentpaths_test

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

func TestEnsurePrivateDirGrantsOnlyTheCurrentUser(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "a", "private")
	if err := agentpaths.EnsurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	sid := user.User.Sid.String()
	if sddl := sd.String(); control&windows.SE_DACL_PROTECTED == 0 || !onlyAllows(sddl, sid) {
		t.Fatalf("DACL = %s, want a protected DACL that allows only %s", sddl, sid)
	}

	child := filepath.Join(dir, "s.sock")
	if err := os.WriteFile(child, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	childSD, err := windows.GetNamedSecurityInfo(child, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if got := childSD.String(); !onlyAllows(got, sid) {
		t.Fatalf("a file in the directory has DACL %s, want only %s", got, sid)
	}

	if err := agentpaths.EnsurePrivateDir(dir); err != nil {
		t.Fatalf("second call: %v", err)
	}
}

func onlyAllows(sddl, sid string) bool {
	aces := strings.Split(strings.TrimSuffix(sddl[strings.Index(sddl, "(")+1:], ")"), ")(")
	for _, ace := range aces {
		fields := strings.Split(ace, ";")
		if len(fields) != 6 || fields[0] != "A" || fields[5] != sid {
			return false
		}
	}
	return len(aces) > 0
}

func TestEnsurePrivateDirRefusesAJunction(t *testing.T) {
	base := shortTempDir(t)
	target := filepath.Join(base, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J: %v %s", err, out)
	}
	t.Cleanup(func() { _ = os.Remove(link) })
	before, err := windows.GetNamedSecurityInfo(target, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if err := agentpaths.EnsurePrivateDir(link); err == nil {
		t.Fatal("accepted a junction")
	}
	after, err := windows.GetNamedSecurityInfo(target, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if before.String() != after.String() {
		t.Fatalf("changed the DACL behind the junction from %s to %s", before, after)
	}
}

func currentUserSID(t *testing.T) string {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return user.User.Sid.String()
}

func mkdirWithSDDL(t *testing.T, dir, sddl string) {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	name, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		t.Fatal(err)
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	if err := windows.CreateDirectory(name, &sa); err != nil {
		t.Fatalf("CreateDirectory %s: %v", dir, err)
	}
}

func daclOf(t *testing.T, path string) string {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	return sd.String()
}

func TestEnsurePrivateDirKeepsAGoodExistingDirectoryAsItIs(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "kept")
	mkdirWithSDDL(t, dir, "D:P(A;OICI;FA;;;"+currentUserSID(t)+")")
	before := daclOf(t, dir)
	if err := agentpaths.EnsurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	if after := daclOf(t, dir); after != before {
		t.Fatalf("rewrote the DACL of an existing directory from %s to %s", before, after)
	}
}

func TestEnsurePrivateDirRefusesAnExistingDirectoryOthersCanReach(t *testing.T) {
	sid := currentUserSID(t)
	for name, sddl := range map[string]string{
		"inherited":      "",
		"everyone":       "D:P(A;OICI;GA;;;" + sid + ")(A;OICI;FA;;;WD)",
		"users":          "D:P(A;OICI;GA;;;" + sid + ")(A;;FR;;;BU)",
		"deny":           "D:P(A;OICI;GA;;;" + sid + ")(D;;FA;;;WD)",
		"null dacl":      "D:NO_ACCESS_CONTROL",
		"admins as well": "D:P(A;OICI;GA;;;" + sid + ")(A;OICI;GA;;;BA)",
	} {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(shortTempDir(t), "reach")
			if sddl == "" {
				if err := os.Mkdir(dir, 0o700); err != nil {
					t.Fatal(err)
				}
			} else {
				mkdirWithSDDL(t, dir, sddl)
			}
			before := daclOf(t, dir)
			err := agentpaths.EnsurePrivateDir(dir)
			if !errors.Is(err, agentpaths.ErrNotPrivate) {
				t.Fatalf("EnsurePrivateDir(%s) = %v, want ErrNotPrivate", before, err)
			}
			if !strings.Contains(err.Error(), fmt.Sprintf("%q", dir)) {
				t.Errorf("error %q does not name %s", err, dir)
			}
			if after := daclOf(t, dir); after != before {
				t.Fatalf("changed the DACL from %s to %s", before, after)
			}
		})
	}
}

func TestEnsurePrivateDirRefusesAFile(t *testing.T) {
	file := filepath.Join(shortTempDir(t), "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := agentpaths.EnsurePrivateDir(file); !errors.Is(err, agentpaths.ErrNotPrivate) {
		t.Fatalf("EnsurePrivateDir(file) = %v, want ErrNotPrivate", err)
	}
}

func TestEnsurePrivateDirNamesTheDirectoryWhenItCannotCheck(t *testing.T) {
	for _, sddl := range []string{"D:P(A;OICI;GA;;;SY)", "D:P(A;OICI;GA;;;SY)(A;;0x1;;;OW)"} {
		dir := filepath.Join(shortTempDir(t), "locked")
		mkdirWithSDDL(t, dir, sddl)
		err := agentpaths.EnsurePrivateDir(dir)
		if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("%q", dir)) {
			t.Fatalf("EnsurePrivateDir(%s) = %v, want an error naming %s", sddl, err, dir)
		}
	}
}
