//go:build !windows

package git

import "os/exec"

func runGitWithOutputLimit(cmd *exec.Cmd, _ *cappedBuffer) (runErr, cleanupErr error) {
	return cmd.Run(), nil
}
