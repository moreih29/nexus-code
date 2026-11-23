package git

import (
	"context"
	"encoding/json"
	"testing"
)

func TestRemoteNameInvalidRejected(t *testing.T) {
	service := New(t.TempDir())
	cases := []string{"", "-bad", "has space"}
	for _, name := range cases {
		raw, _ := json.Marshal(map[string]string{"name": name, "url": "https://example.invalid/r.git"})
		_, err := service.RemoteAdd(context.Background(), raw)
		if err == nil {
			t.Errorf("RemoteAdd(%q) should reject invalid name", name)
		}
	}
}
