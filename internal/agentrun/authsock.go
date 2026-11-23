//go:build !windows

package agentrun

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const maxSunPath = 104

func AuthSockFor(sockPath string) string {
	return strings.TrimSuffix(sockPath, ".sock") + ".agent"
}

func PointAuthSock(link, target string) error {
	if target == "" || filepath.Clean(target) == link {
		return nil
	}
	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("agentrun: %s is not a socket", target)
	}
	tmp := fmt.Sprintf("%s.%d.tmp", link, os.Getpid())
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, link); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func SetConnectionAuthSock(link, target string) error {
	if target != "" {
		return PointAuthSock(link, target)
	}
	if _, err := os.Readlink(link); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return os.Remove(link)
}

func AdoptAuthSock(link string) bool {
	if len(link) >= maxSunPath {
		return false
	}
	if err := SetConnectionAuthSock(link, os.Getenv("SSH_AUTH_SOCK")); err != nil {
		return false
	}
	return os.Setenv("SSH_AUTH_SOCK", link) == nil
}
