//go:build !windows

package git

import "os/exec"

// runGitWithOutputLimit runs Git with the configured stdout overflow handler.
func runGitWithOutputLimit(cmd *exec.Cmd, _ *cappedBuffer) (runErr, cleanupErr error) {
	return cmd.Run(), nil
}
