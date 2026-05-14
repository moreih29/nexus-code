package lsp

import (
	"encoding/json"
	"io"
)

func (p *serverProcess) readLoop() {
	decoder := NewDecoder()
	buf := make([]byte, 32*1024)
	for {
		n, err := p.stdout.Read(buf)
		if n > 0 {
			messages, decodeErr := decoder.Append(buf[:n])
			for _, message := range messages {
				p.handleMessage(message)
			}
			if decodeErr != nil {
				p.failInternal(decodeErr)
				p.forceClose()
				return
			}
		}
		if err != nil {
			if err != io.EOF {
				p.failInternal(err)
			}
			return
		}
	}
}

func (p *serverProcess) handleMessage(message json.RawMessage) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(message, &obj); err != nil {
		return
	}

	method, hasMethod := stringField(obj["method"])
	id, hasID := obj["id"]
	_, hasResult := obj["result"]
	_, hasError := obj["error"]

	if hasID && hasMethod {
		if _, ok := jsonRPCIDKey(id); ok {
			p.handleServerRequest(id, method, obj["params"])
			return
		}
	}

	if hasID && (hasResult || hasError) {
		if p.handleInternalResponse(id, message) {
			return
		}
	}

	_ = p.service.emit(EventMessage, MessagePayload{
		ServerID: p.id,
		Message:  append(json.RawMessage(nil), message...),
	})
}

func (p *serverProcess) handleInternalResponse(id json.RawMessage, message json.RawMessage) bool {
	key, ok := jsonRPCIDKey(id)
	if !ok {
		return false
	}

	p.mu.Lock()
	pending := p.pendingInternal[key]
	if pending != nil {
		delete(p.pendingInternal, key)
	}
	p.mu.Unlock()
	if pending == nil {
		return false
	}

	var parsed struct {
		Result json.RawMessage `json:"result"`
		Error  *jsonRPCError   `json:"error"`
	}
	if err := json.Unmarshal(message, &parsed); err != nil {
		pending <- rpcResponse{Raw: message, Err: err}
		return true
	}
	pending <- rpcResponse{
		Raw:    append(json.RawMessage(nil), message...),
		Result: append(json.RawMessage(nil), parsed.Result...),
		Error:  parsed.Error,
	}
	return true
}

func (p *serverProcess) handleServerRequest(id json.RawMessage, method string, params json.RawMessage) {
	agentRequestID := p.service.nextAgentRequestID(p.id)
	idCopy := append(json.RawMessage(nil), id...)
	watchedFileRegistrations := watchedFileRegistrationsFromServerRequest(method, params)

	p.mu.Lock()
	if p.exited {
		p.mu.Unlock()
		return
	}
	p.pendingServerRequests[agentRequestID] = idCopy
	if len(watchedFileRegistrations) > 0 {
		p.pendingWatchedFileRegistrations[agentRequestID] = watchedFileRegistrations
	}
	p.mu.Unlock()

	payload := ServerRequestPayload{
		ServerID:       p.id,
		AgentRequestID: agentRequestID,
		Method:         method,
		Params:         append(json.RawMessage(nil), params...),
	}
	if err := p.service.emitRequired(EventServerRequest, payload); err != nil {
		p.deleteServerRequest(agentRequestID)
		p.sendErrorResponse(idCopy, -32603, "Server request handler unavailable")
	}
}

func (p *serverProcess) respondServerRequest(params RespondServerRequestParams) error {
	p.mu.Lock()
	id := p.pendingServerRequests[params.AgentRequestID]
	watchedFileRegistrations := p.pendingWatchedFileRegistrations[params.AgentRequestID]
	if len(id) > 0 {
		delete(p.pendingServerRequests, params.AgentRequestID)
		delete(p.pendingWatchedFileRegistrations, params.AgentRequestID)
	}
	p.mu.Unlock()
	if len(id) == 0 {
		return requestFailed("lsp server request not found: %s", params.AgentRequestID)
	}

	response := rawRequestIDResponse{
		JSONRPC: "2.0",
		ID:      append(json.RawMessage(nil), id...),
	}
	if len(params.Error) > 0 {
		response.Error = append(json.RawMessage(nil), params.Error...)
	} else if len(params.Result) > 0 {
		response.Result = append(json.RawMessage(nil), params.Result...)
	} else {
		response.Result = json.RawMessage("null")
	}

	raw, err := json.Marshal(response)
	if err != nil {
		return err
	}
	if err := p.sendRaw(raw); err != nil {
		return err
	}
	if len(params.Error) == 0 {
		p.addWatchedFileRegistrations(watchedFileRegistrations)
	}
	return nil
}

func (p *serverProcess) sendErrorResponse(id json.RawMessage, code int, message string) {
	errBody, err := json.Marshal(jsonRPCError{Code: code, Message: message})
	if err != nil {
		return
	}
	raw, err := json.Marshal(rawRequestIDResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   errBody,
	})
	if err != nil {
		return
	}
	_ = p.sendRaw(raw)
}
