// Package proto defines the NDJSON wire envelope shared by the
// agent binary and its TS client. The format mirrors
// `src/shared/protocol/agent/envelope.ts` byte for byte —
// changes here must land on both sides, and the round-trip
// integration test catches anything that drifts.
//
// Three frame shapes share the channel:
//   - Request  (client → server, correlated by id)
//   - Response (server → client, correlated by id, carries result XOR error)
//   - Ready    (server → client, one-shot boot frame)
//
// Server-push events (no id, used for fs.changed / search progress)
// share the same stdout stream as responses and are routed by `event`.
package proto

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
)

// Protocol version constants advertised on the boot Ready frame so the
// client can refuse to talk to a server with an incompatible envelope
// shape. Bump ProtocolVersion when the wire format changes in a way
// that breaks older clients; bump ServerVersion for behavior changes
// inside the existing wire shape.
const (
	ProtocolVersion = "1"
	ServerVersion   = "0.1.0"

	// CodeProtocolError signals envelope-level failures: malformed
	// JSON, missing required fields, version mismatch. The client
	// must not retry — the request never reached domain logic.
	CodeProtocolError = "server.protocol-error"

	// CodeRequestFailed is the fallback error code used when a domain
	// handler returns an error with no recoverable code attached.
	CodeRequestFailed = "server.request-failed"

	// CodeUnsupported is returned for method names with no registered
	// handler. Typically indicates a TS client running ahead of the
	// deployed Go agent.
	CodeUnsupported = "unsupported-method"

	// ProtocolErrorID is the synthetic request id used when a parse
	// failure happens before we can recover the real id from the raw
	// line. Clients should treat it as unmatched and surface it as a
	// transport-level error rather than a per-request failure.
	ProtocolErrorID = "server-protocol-error"
)

// Request is the wire shape of a client → server request frame.
// `Params` is left as RawMessage so handlers can parse into their own
// strongly-typed shape without an intermediate any/map round-trip.
type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// ErrorFrame is the failure payload nested inside a Response. Code is
// the stable identifier the client matches on; Message is for human
// display and may carry path context — never sensitive data.
type ErrorFrame struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Response carries either Result or Error, never both. `omitempty`
// drops the unset field so the wire JSON cleanly tells the client
// which variant arrived. A void-returning handler emits Result=nil,
// which serializes to a frame with neither field (just `{"id":"x"}`).
type Response struct {
	ID     string      `json:"id"`
	Result any         `json:"result,omitempty"`
	Error  *ErrorFrame `json:"error,omitempty"`
}

// ReadyFrame is the one-shot boot frame the server writes to stdout
// before accepting requests. The client uses it as both a liveness
// probe and a protocol-version check.
type ReadyFrame struct {
	Type            string `json:"type"`
	ProtocolVersion string `json:"protocolVersion"`
	ServerVersion   string `json:"serverVersion"`
}

// EventFrame is a server → client broadcast frame. It deliberately has no id:
// events are not request responses and are routed by event name on the client.
type EventFrame struct {
	Event   string `json:"event"`
	Payload any    `json:"payload,omitempty"`
}

// Ready builds the canonical boot frame.
func Ready() ReadyFrame {
	return ReadyFrame{Type: "ready", ProtocolVersion: ProtocolVersion, ServerVersion: ServerVersion}
}

// Event builds the canonical server-push frame.
func Event(event string, payload any) EventFrame {
	return EventFrame{Event: event, Payload: payload}
}

// ParseRequest decodes one NDJSON line into a Request. id and method
// are required; params is optional. Missing required fields surface as
// CodedError(CodeProtocolError) so the caller can route them through
// ProtocolFailure with the same code the client expects.
func ParseRequest(line []byte) (Request, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(line, &raw); err != nil {
		return Request{}, err
	}

	var req Request
	if idRaw, ok := raw["id"]; !ok || json.Unmarshal(idRaw, &req.ID) != nil {
		return Request{}, ProtocolError("request must include string id and method")
	}
	if methodRaw, ok := raw["method"]; !ok || json.Unmarshal(methodRaw, &req.Method) != nil {
		return Request{}, ProtocolError("request must include string id and method")
	}
	if params, ok := raw["params"]; ok {
		req.Params = params
	}
	return req, nil
}

// Success constructs a success-variant Response. The result is wired
// through Go's json package, so any type with stable JSON tags works.
func Success(id string, result any) Response {
	return Response{ID: id, Result: result}
}

// Failure constructs an error-variant Response with an explicit code
// and message. Used by handlers that have a domain-specific error code
// to surface (e.g. fs returning OUT_OF_WORKSPACE).
func Failure(id, code, message string) Response {
	return Response{ID: id, Error: &ErrorFrame{Code: code, Message: message}}
}

// ProtocolFailure constructs a failure Response with the protocol-error
// code preset. Reserved for envelope-level problems — never used by
// domain handlers.
func ProtocolFailure(id, message string) Response {
	return Failure(id, CodeProtocolError, message)
}

// MarshalFrame serializes any frame as NDJSON. The trailing newline is
// what makes this NDJSON instead of a raw JSON object stream — the
// client's scanner relies on it to know one frame has ended.
func MarshalFrame(frame any) ([]byte, error) {
	data, err := json.Marshal(frame)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

// CodedError is the in-process error type that lets domain handlers
// attach a stable error code without depending on the proto package's
// concrete frame shape. Implementations of the small `ErrorCode()`
// interface (e.g. fs.FSError) are preferred over wrapping this
// type directly — it exists mainly to carry parser failures.
type CodedError struct {
	Code string
	Msg  string
}

// Error implements the standard error interface so CodedError can flow
// through `error` returns from handlers and the dispatcher.
func (e CodedError) Error() string { return e.Msg }

// ProtocolError tags an envelope-level message with the protocol-error
// code. Used by ParseRequest and the host's protocolMessage shaper.
func ProtocolError(message string) CodedError {
	return CodedError{Code: CodeProtocolError, Msg: message}
}

// ErrorCode extracts the stable wire code from an error. Domain types
// that expose `ErrorCode() string` win first; CodedError wins next;
// everything else collapses to CodeRequestFailed so we never leak an
// untagged error to the client.
func ErrorCode(err error) string {
	var coded interface{ ErrorCode() string }
	if errors.As(err, &coded) && coded.ErrorCode() != "" {
		return coded.ErrorCode()
	}
	var ce CodedError
	if errors.As(err, &ce) && ce.Code != "" {
		return ce.Code
	}
	return CodeRequestFailed
}

// ErrorResponse builds a failure Response from an arbitrary error,
// pulling the wire code via ErrorCode and the message from err.Error().
func ErrorResponse(id string, err error) Response {
	return Failure(id, ErrorCode(err), err.Error())
}

// IDFromParsedFrame recovers the request id from a line that parsed as
// JSON but failed validation (e.g. method missing). Returns "" when
// the line cannot be parsed or has no string id — callers fall back to
// IDFromMalformedLine for the remaining cases.
func IDFromParsedFrame(line []byte) string {
	var raw map[string]json.RawMessage
	if json.Unmarshal(line, &raw) != nil {
		return ""
	}
	var id string
	if json.Unmarshal(raw["id"], &id) != nil {
		return ""
	}
	return id
}

// idPattern best-effort matches an `"id":"..."` substring inside a
// line we could not parse as JSON. The regex permits backslash escapes
// inside the value so an embedded quote (`"id":"a\"b"`) still matches.
var idPattern = regexp.MustCompile(`"id"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"`)

// IDFromMalformedLine pulls an id out of an unparseable line so the
// client can still correlate a parse-failure response with the
// original request. Falls back to "" when no id substring is present.
func IDFromMalformedLine(line string) string {
	match := idPattern.FindStringSubmatch(line)
	if len(match) != 2 {
		return ""
	}
	id, err := strconv.Unquote(fmt.Sprintf("\"%s\"", match[1]))
	if err != nil {
		return ""
	}
	return id
}
