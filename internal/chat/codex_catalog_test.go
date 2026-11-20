package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
)

func TestWriteCodexCatalogKeepsLaunchesIndependent(t *testing.T) {
	root := t.TempDir()
	t.Setenv(agentpaths.HomeEnv, root)
	service := New()
	for _, id := range []string{"first", "second"} {
		catalog := `{"models":[{"slug":"` + id + `"}]}`
		params := json.RawMessage(`{"catalog":` + catalog + `}`)
		result, err := service.WriteCodexCatalog(context.Background(), params)
		if err != nil {
			t.Fatal(err)
		}
		path := result.(string)
		if filepath.Dir(path) != filepath.Join(root, "run", "codex-catalogs") {
			t.Fatalf("unexpected catalog path %q", path)
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != catalog {
			t.Fatalf("catalog on disk = %s, %v", data, err)
		}
		again, err := service.WriteCodexCatalog(context.Background(), params)
		if err != nil || again != path {
			t.Fatalf("same catalog path = %v, %v", again, err)
		}
	}
	entries, err := os.ReadDir(filepath.Join(root, "run", "codex-catalogs"))
	if err != nil || len(entries) != 2 {
		t.Fatalf("catalog files = %v, %v", entries, err)
	}
}
