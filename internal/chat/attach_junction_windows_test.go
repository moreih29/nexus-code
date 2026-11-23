package chat

import (
	"os/exec"
	"testing"
)

// junction makes link a directory junction to target (mklink /J), which
// needs no privilege, unlike a symbolic link; the test skips without one.
func junction(t *testing.T, link, target string) {
	t.Helper()
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skipf("no junction here: %v %s", err, out)
	}
}

// Windows junctions, as the symbolic links of TestAttachmentCallsFollowNoLinkOfAnyKind.
func TestAttachmentCallsFollowNoJunction(t *testing.T) {
	attachmentCallsFollowNo(t, junction)
}
