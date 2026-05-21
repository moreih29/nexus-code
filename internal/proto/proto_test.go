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

func TestSuccessCoercesNilResultToExplicitNull(t *testing.T) {
	// Handlers that return (nil, nil) must still produce a frame the client
	// can route. Without coercion `omitempty` drops the result key and the
	// TS pipe's parseFrame rejects the resulting `{"id":"x"}` as malformed,
	// tearing the channel down. The coercion in Success keeps the wire
	// frame as `{"id":"x","result":null}`.
	line, err := MarshalFrame(Success("r-46", nil))
	if err != nil {
		t.Fatalf("MarshalFrame() error = %v", err)
	}
	if string(line) != `{"id":"r-46","result":null}`+"\n" {
		t.Fatalf("nil-result frame = %s, want {\"id\":\"r-46\",\"result\":null}", line)
	}
}

func TestReadyFrameIncludesVersions(t *testing.T) {
	// methods 슬라이스와 heartbeat 간격을 함께 전달한 경우 wire 포맷 확인.
	data, err := json.Marshal(Ready([]string{"fs.readFile", "git.log"}, 10_000))
	if err != nil {
		t.Fatalf("Marshal ready: %v", err)
	}
	want := `{"type":"ready","protocolVersion":"1","serverVersion":"0.1.0","methods":["fs.readFile","git.log"],"heartbeatIntervalMs":10000}`
	if string(data) != want {
		t.Fatalf("ready frame = %s, want %s", data, want)
	}
}

func TestReadyFrameNilMethodsCoercedToEmptySlice(t *testing.T) {
	// nil methods는 빈 슬라이스로 변환되어 JSON "methods":[] 로 직렬화된다.
	f := Ready(nil, 0)
	if f.Methods == nil {
		t.Fatal("Ready(nil, 0).Methods must not be nil — want empty slice")
	}
	data, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	want := `{"type":"ready","protocolVersion":"1","serverVersion":"0.1.0","methods":[],"heartbeatIntervalMs":0}`
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
