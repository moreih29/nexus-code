package proto

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
)

var ServerVersion = "0.1.0"

const MaxHookRequestBytes = 16 * 1024 * 1024

const (
	ProtocolVersion = "2"

	HeartbeatAdvertiseMs = 5_000
	HeartbeatSendMs      = 4_000

	CodeProtocolError = "server.protocol-error"

	CodeRequestFailed = "server.request-failed"

	CodeUnsupported = "unsupported-method"

	CodeUnavailable = "server.unavailable"

	ProtocolErrorID = "server-protocol-error"
)

type Request struct {
	ID            string          `json:"id"`
	Method        string          `json:"method"`
	Params        json.RawMessage `json:"params,omitempty"`
	CorrelationID string          `json:"correlationId,omitempty"`
}

type ErrorFrame struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type Response struct {
	ID     string      `json:"id"`
	Result any         `json:"result,omitempty"`
	Error  *ErrorFrame `json:"error,omitempty"`
}

type ReadyFrame struct {
	Type                string   `json:"type"`
	ProtocolVersion     string   `json:"protocolVersion"`
	ServerVersion       string   `json:"serverVersion"`
	Methods             []string `json:"methods"`
	HeartbeatIntervalMs int      `json:"heartbeatIntervalMs"`
	IdleWatchdogMs      int      `json:"idleWatchdogMs"`
	AgentEpoch          uint64   `json:"agentEpoch,omitempty"`
	Capabilities        []string `json:"capabilities,omitempty"`
}

type EventFrame struct {
	Event   string `json:"event"`
	Payload any    `json:"payload,omitempty"`
}

func Ready(methods []string, heartbeatIntervalMs int, idleWatchdogMs int, agentEpoch uint64, capabilities []string) ReadyFrame {
	if methods == nil {
		methods = []string{}
	}
	return ReadyFrame{
		Type:                "ready",
		ProtocolVersion:     ProtocolVersion,
		ServerVersion:       ServerVersion,
		Methods:             methods,
		HeartbeatIntervalMs: heartbeatIntervalMs,
		IdleWatchdogMs:      idleWatchdogMs,
		AgentEpoch:          agentEpoch,
		Capabilities:        capabilities,
	}
}

func Event(event string, payload any) EventFrame {
	return EventFrame{Event: event, Payload: payload}
}

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
	if corrRaw, ok := raw["correlationId"]; ok {
		_ = json.Unmarshal(corrRaw, &req.CorrelationID)
	}
	return req, nil
}

func Success(id string, result any) Response {
	if result == nil {
		result = json.RawMessage("null")
	}
	return Response{ID: id, Result: result}
}

func Failure(id, code, message string) Response {
	return Response{ID: id, Error: &ErrorFrame{Code: code, Message: message}}
}

func ProtocolFailure(id, message string) Response {
	return Failure(id, CodeProtocolError, message)
}

func MarshalFrame(frame any) ([]byte, error) {
	data, err := json.Marshal(frame)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

type CodedError struct {
	Code string
	Msg  string
}

func (e CodedError) Error() string { return e.Msg }

func ProtocolError(message string) CodedError {
	return CodedError{Code: CodeProtocolError, Msg: message}
}

func RequestFailed(format string, args ...any) CodedError {
	return CodedError{Code: CodeRequestFailed, Msg: fmt.Sprintf(format, args...)}
}

func NewError(code, message string) CodedError {
	return CodedError{Code: code, Msg: message}
}

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

func coded(err error) bool {
	var withCode interface{ ErrorCode() string }
	var ce CodedError
	return errors.As(err, &withCode) || errors.As(err, &ce)
}

func ErrorResponse(id string, err error) Response {
	message := err.Error()
	if !coded(err) {
		message = Reason(err)
	}
	resp := Failure(id, ErrorCode(err), message)
	var withData interface{ ErrorData() any }
	if errors.As(err, &withData) {
		resp.Error.Data = withData.ErrorData()
	}
	return resp
}

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

var idPattern = regexp.MustCompile(`"id"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"`)

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
