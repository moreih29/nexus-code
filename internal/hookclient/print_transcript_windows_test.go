package hookclient

import (
	"os/exec"
	"testing"
)

func TestPrintTranscriptFollowsNoJunction(t *testing.T) {
	printTranscriptFollowsNoLink(t, printSymlink, func(t *testing.T, target, link string) {
		t.Helper()
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
			t.Skipf("no junction here: %v %s", err, out)
		}
	})
}
