package chat

import "testing"

func TestClaudeLookupsFollowNoJunction(t *testing.T) {
	claudeLookupsFollowNoLink(t, symlinkOrSkip, func(t *testing.T, target, link string) {
		junction(t, link, target)
	})
}
