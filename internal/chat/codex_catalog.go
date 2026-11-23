package chat

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/nexus-code/nexus-code/internal/agentpaths"
	"github.com/nexus-code/nexus-code/internal/proto"
)

type codexCatalogParams struct {
	Catalog json.RawMessage `json:"catalog"`
}

func (s *Service) WriteCodexCatalog(_ context.Context, raw json.RawMessage) (any, error) {
	var p codexCatalogParams
	if err := proto.DecodeParams(raw, &p, "chat.writeCodexCatalog requires a catalog"); err != nil {
		return nil, err
	}
	var catalog struct {
		Models []json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(p.Catalog, &catalog); err != nil || len(catalog.Models) == 0 {
		return nil, proto.ProtocolError("chat.writeCodexCatalog requires models")
	}

	dir, err := agentpaths.RunDir()
	if err != nil {
		return nil, proto.RequestFailed("chat.writeCodexCatalog: %s", proto.Reason(err))
	}
	dir = filepath.Join(dir, "codex-catalogs")
	if err = agentpaths.EnsureDir(dir); err != nil {
		return nil, proto.RequestFailed("chat.writeCodexCatalog: %s", proto.Reason(err))
	}
	path := filepath.Join(dir, fmt.Sprintf("%x.json", sha256.Sum256(p.Catalog)))
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	file, err := os.CreateTemp(dir, ".catalog-*")
	if err != nil {
		return nil, proto.RequestFailed("chat.writeCodexCatalog: %s", proto.Reason(err))
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(p.Catalog)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		return nil, proto.RequestFailed("chat.writeCodexCatalog: %s", proto.Reason(errors.Join(writeErr, closeErr)))
	}
	if err := os.Rename(file.Name(), path); err != nil {
		if _, statErr := os.Stat(path); statErr != nil {
			return nil, proto.RequestFailed("chat.writeCodexCatalog: %s", proto.Reason(err))
		}
	}
	return path, nil
}
