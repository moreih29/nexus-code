package chat

import (
	"os/exec"
	"testing"
)

func junction(t *testing.T, link, target string) {
	t.Helper()
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skipf("no junction here: %v %s", err, out)
	}
}

func TestAttachmentCallsFollowNoJunction(t *testing.T) {
	attachmentCallsFollowNo(t, junction)
}
