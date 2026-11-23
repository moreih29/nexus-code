package fs

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"sync"
)

const (
	maxPreviewVersionBytes = 8 * 1024 * 1024
	previewProofBlockBytes = 64 * 1024
	maxPreviewProofs       = 64
)

var previewFingerprintSlots = make(chan struct{}, 2)

type previewDigest = [sha256.Size]byte

var previewProofs = struct {
	sync.Mutex
	byVersion map[string][]previewDigest
	order     []string
}{byVersion: make(map[string][]previewDigest)}

func rememberPreviewProof(version string, proof []previewDigest) {
	previewProofs.Lock()
	defer previewProofs.Unlock()
	if _, exists := previewProofs.byVersion[version]; exists {
		return
	}
	if len(previewProofs.order) == maxPreviewProofs {
		delete(previewProofs.byVersion, previewProofs.order[0])
		previewProofs.order = previewProofs.order[1:]
	}
	previewProofs.byVersion[version] = proof
	previewProofs.order = append(previewProofs.order, version)
}

func previewProofFor(version string) []previewDigest {
	previewProofs.Lock()
	defer previewProofs.Unlock()
	return previewProofs.byVersion[version]
}

func provePreview(key [32]byte, metadata string, contents []byte) (string, []previewDigest) {
	mac := hmac.New(sha256.New, key[:])
	mac.Write([]byte(metadata))
	proof := make([]previewDigest, 0, (len(contents)+previewProofBlockBytes-1)/previewProofBlockBytes)
	for start := 0; start < len(contents); start += previewProofBlockBytes {
		end := min(len(contents), start+previewProofBlockBytes)
		digest := sha256.Sum256(contents[start:end])
		mac.Write(digest[:])
		proof = append(proof, digest)
	}
	return metadata + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), proof
}
