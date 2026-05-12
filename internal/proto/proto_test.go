package proto

import (
	"encoding/json"
	"testing"
)

func TestParseRequestAndMarshalShapes(t *testing.T) {
	req, err := ParseRequest([]byte(`{"id":"1","method":"fs.readdir","params":{"relPath":"."}}`))
	if err != nil {
		t.Fatalf("ParseRequest() error = %v", err)
	}
	if req.ID != "1" || req.Method != "fs.readdir" || string(req.Params) != `{"relPath":"."}` {
		t.Fatalf("unexpected request: %#v params=%s", req, req.Params)
	}

	line, err := MarshalFrame(Success("1", map[string]string{"ok": "yes"}))
	if err != nil {
		t.Fatalf("MarshalFrame() error = %v", err)
	}
	if string(line) != `{"id":"1","result":{"ok":"yes"}}`+"\n" {
		t.Fatalf("success frame mismatch: %s", line)
	}

	line, err = MarshalFrame(Failure("2", CodeUnsupported, "method not supported: fs.writeFile"))
	if err != nil {
		t.Fatalf("MarshalFrame() error = %v", err)
	}
	if string(line) != `{"id":"2","error":{"code":"unsupported-method","message":"method not supported: fs.writeFile"}}`+"\n" {
		t.Fatalf("error frame mismatch: %s", line)
	}
}

func TestReadyFrameIncludesVersions(t *testing.T) {
	data, err := json.Marshal(Ready())
	if err != nil {
		t.Fatalf("Marshal ready: %v", err)
	}
	want := `{"type":"ready","protocolVersion":"1","serverVersion":"0.1.0"}`
	if string(data) != want {
		t.Fatalf("ready frame = %s, want %s", data, want)
	}
}

func TestIDRecovery(t *testing.T) {
	if got := IDFromMalformedLine(`{"id":"bad-json","method":"fs.readdir","params":`); got != "bad-json" {
		t.Fatalf("IDFromMalformedLine() = %q", got)
	}
	if got := IDFromParsedFrame([]byte(`{"id":"parsed","method":1}`)); got != "parsed" {
		t.Fatalf("IDFromParsedFrame() = %q", got)
	}
}

func TestProtocolValidation(t *testing.T) {
	_, err := ParseRequest([]byte(`{"id":"1","params":{}}`))
	if err == nil {
		t.Fatal("expected validation error")
	}
	if ErrorCode(err) != CodeProtocolError {
		t.Fatalf("ErrorCode() = %q", ErrorCode(err))
	}
}
