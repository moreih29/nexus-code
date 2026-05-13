package git

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/nexus-code/nexus-code/internal/content"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const defaultBlobMaxBytes int64 = maxGitFileContentBytes

type BlobParams struct {
	StreamID      string `json:"streamId,omitempty"`
	Cwd           string `json:"cwd,omitempty"`
	Ref           string `json:"ref"`
	RelPath       string `json:"relPath"`
	MaxBytes      int64  `json:"maxBytes,omitempty"`
	MaxChunkBytes int    `json:"maxChunkBytes,omitempty"`
}

type BlobResult struct {
	Size         int64  `json:"size"`
	IsBinary     bool   `json:"isBinary"`
	Encoding     string `json:"encoding"`
	Mtime        *int64 `json:"mtime"`
	Truncated    bool   `json:"truncated"`
	ErrorKind    Kind   `json:"errorKind,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

type BlobChunkPayload struct {
	StreamID    string           `json:"streamId,omitempty"`
	Chunk       string           `json:"chunk"`
	HeaderProbe *BlobHeaderProbe `json:"headerProbe,omitempty"`
}

type BlobHeaderProbe struct {
	IsBinary    bool   `json:"isBinary"`
	Encoding    string `json:"encoding"`
	ProbeBytes  int    `json:"probeBytes"`
	ProbeBase64 string `json:"probeBase64"`
}

type blobHeader struct {
	Size    int64
	Missing bool
}

// Blob streams one repository blob using git cat-file --batch. Working-tree
// content is intentionally excluded; callers should use fs.readFile for that.
func (s *Service) Blob(ctx context.Context, raw json.RawMessage) (any, error) {
	params, err := parseBlobParams(raw)
	if err != nil {
		return nil, err
	}
	objectSpec := blobObjectSpec(params.Ref, params.RelPath)

	cmdCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if params.StreamID != "" {
		if err := s.registerStream(params.StreamID, cancel); err != nil {
			return nil, err
		}
		defer s.unregisterStream(params.StreamID)
	}
	cmd, err := s.command(cmdCtx, []string{"cat-file", "--batch"}, params.Cwd, nil, false)
	if err != nil {
		return nil, err
	}
	cmd.Stdin = strings.NewReader(objectSpec + "\n")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, mapGitStartError(err, []string{"cat-file", "--batch"})
	}

	emit := func(payload BlobChunkPayload) error {
		s.mu.Lock()
		sink := s.sink
		s.mu.Unlock()
		if sink == nil {
			return nil
		}
		return sink("git.blob.chunk", payload)
	}
	result, readErr := parseBlobCatFileOutput(ctx, params, stdout, emit)
	if readErr != nil || result.Truncated {
		cancel()
	}
	waitErr := cmd.Wait()
	if readErr != nil {
		return nil, readErr
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	if result.Truncated && cmdCtx.Err() != nil {
		return result, nil
	}
	code, fatal := gitExitCode(waitErr)
	if fatal != nil {
		return nil, fatal
	}
	if code != 0 {
		return nil, proto.CodedError{Code: proto.CodeRequestFailed, Msg: strings.TrimSpace(stderr.String())}
	}
	return result, nil
}

func parseBlobParams(raw json.RawMessage) (BlobParams, error) {
	var params BlobParams
	if len(raw) == 0 || json.Unmarshal(raw, &params) != nil {
		return params, proto.ProtocolError("git.blob params must include ref and relPath")
	}
	ref, err := normalizeRef(params.Ref)
	if err != nil {
		return params, err
	}
	if ref == "WORKING" {
		return params, proto.CodedError{Code: proto.CodeRequestFailed, Msg: "git.blob does not support WORKING refs; use fs.readFile for working-tree content"}
	}
	if strings.Contains(params.StreamID, "\x00") {
		return params, proto.ProtocolError("git.blob streamId must not contain NUL")
	}
	if strings.Contains(params.Cwd, "\x00") {
		return params, proto.ProtocolError("git.blob cwd must not contain NUL")
	}
	relPath, err := normalizeRelPath(params.RelPath)
	if err != nil {
		return params, err
	}
	params.Ref = ref
	params.RelPath = relPath
	if params.MaxBytes <= 0 {
		params.MaxBytes = defaultBlobMaxBytes
	}
	if params.MaxChunkBytes <= 0 {
		params.MaxChunkBytes = streamChunkBytes
	}
	return params, nil
}

func parseBlobCatFileOutput(ctx context.Context, params BlobParams, stdout io.Reader, emit func(BlobChunkPayload) error) (BlobResult, error) {
	reader := bufio.NewReader(stdout)
	header, err := readBlobHeader(reader)
	if err != nil {
		return BlobResult{}, err
	}
	if header.Missing {
		return BlobResult{Mtime: nil, ErrorKind: KindMissing, ErrorMessage: blobMissingMessage(params.Ref, params.RelPath)}, nil
	}

	result := BlobResult{Size: header.Size, Encoding: "utf8", Mtime: nil, Truncated: header.Size > params.MaxBytes}
	toEmit := header.Size
	if toEmit > params.MaxBytes {
		toEmit = params.MaxBytes
	}
	remaining := toEmit
	firstChunk := true
	for remaining > 0 {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		chunkSize := int64(params.MaxChunkBytes)
		if chunkSize > remaining {
			chunkSize = remaining
		}
		chunk := make([]byte, chunkSize)
		if _, err := io.ReadFull(reader, chunk); err != nil {
			return result, err
		}
		payload := BlobChunkPayload{StreamID: params.StreamID, Chunk: base64.StdEncoding.EncodeToString(chunk)}
		if firstChunk {
			probeBytes := chunk
			if len(probeBytes) > content.BinaryProbeBytes {
				probeBytes = probeBytes[:content.BinaryProbeBytes]
			}
			isBinary, encoding := probeBlobHeader(probeBytes)
			result.IsBinary = isBinary
			result.Encoding = encoding
			payload.HeaderProbe = &BlobHeaderProbe{
				IsBinary:    isBinary,
				Encoding:    encoding,
				ProbeBytes:  len(probeBytes),
				ProbeBase64: base64.StdEncoding.EncodeToString(probeBytes),
			}
			firstChunk = false
		}
		if err := emit(payload); err != nil {
			return result, err
		}
		remaining -= chunkSize
	}
	return result, nil
}

func readBlobHeader(reader *bufio.Reader) (blobHeader, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return blobHeader{}, err
	}
	line = strings.TrimSuffix(line, "\n")
	line = strings.TrimSuffix(line, "\r")
	if strings.HasSuffix(line, " missing") {
		return blobHeader{Missing: true}, nil
	}
	fields := strings.Fields(line)
	if len(fields) != 3 || fields[1] != "blob" {
		return blobHeader{}, fmt.Errorf("unexpected git cat-file header %q", line)
	}
	size, err := strconv.ParseInt(fields[2], 10, 64)
	if err != nil || size < 0 {
		return blobHeader{}, fmt.Errorf("unexpected git cat-file blob size %q", fields[2])
	}
	return blobHeader{Size: size}, nil
}

func probeBlobHeader(probe []byte) (bool, string) {
	if content.IsBinaryProbe(probe) {
		return true, "binary"
	}
	if len(probe) >= 3 && probe[0] == 0xef && probe[1] == 0xbb && probe[2] == 0xbf {
		return false, "utf8-bom"
	}
	return false, "utf8"
}

func blobObjectSpec(ref string, relPath string) string {
	if ref == "INDEX" {
		return ":" + relPath
	}
	return ref + ":" + relPath
}

func blobMissingMessage(ref string, relPath string) string {
	return fmt.Sprintf("Path %s does not exist in %s", relPath, ref)
}
