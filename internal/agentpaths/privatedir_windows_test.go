package agentpaths_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

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
