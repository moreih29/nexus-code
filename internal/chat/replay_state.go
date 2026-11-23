package chat

import "encoding/json"

type replayRequest struct {
	line          *entry
	key           string
	bypassAttempt bool
}

func (l *lineLog) trackReplayRequest(line *entry, message json.RawMessage) bool {
	var input struct {
		ID      string `json:"request_id"`
		Request struct {
			Subtype  string `json:"subtype"`
			Mode     string `json:"mode"`
			Settings struct {
				EffortLevel string `json:"effortLevel"`
			} `json:"settings"`
		} `json:"request"`
	}
	if json.Unmarshal(message, &input) != nil || input.ID == "" {
		return false
	}
	key := input.Request.Subtype
	switch key {
	case "initialize", "set_model", "set_permission_mode", "get_settings", "remote_control":
	case "apply_flag_settings":
		if input.Request.Settings.EffortLevel == "" {
			return false
		}
	default:
		return false
	}
	line.requestID = input.ID
	l.requests[input.ID] = replayRequest{line, key, input.Request.Mode == "bypassPermissions"}
	l.setReplayPin("pending:"+key, line, nil)
	return true
}

func (l *lineLog) forgetReplayRequest(id string) {
	request := l.requests[id]
	key := "pending:" + request.key
	if l.replayPins[key][0] == request.line {
		l.setReplayPin(key, nil, nil)
	}
	delete(l.requests, id)
}

func (l *lineLog) keepReplayState(line *entry, kind string) {
	if line.dir == DirSys && line.message != nil {
		var event struct {
			Name              string `json:"event"`
			ConnectionChanged bool   `json:"connectionChanged"`
		}
		if json.Unmarshal(line.message, &event) == nil {
			if event.Name == "start" {
				l.setReplayPin("start", line, nil)
				if event.ConnectionChanged {
					l.setReplayPin("connection", line, nil)
				}
			}
			if event.Name == "start" || event.Name == "exit" {
				for id := range l.requests {
					l.forgetReplayRequest(id)
				}
			}
		}
		return
	}
	switch kind {
	case "system":
		var system struct {
			Subtype        string `json:"subtype"`
			PermissionMode string `json:"permissionMode"`
		}
		if json.Unmarshal(line.message, &system) == nil {
			switch {
			case system.Subtype == "init":
				l.setReplayPin("system:init", line, nil)
			case system.Subtype == "status" && system.PermissionMode != "":
				l.setReplayPin("system:permission", line, nil)
			}
		}
	case "conversation_reset":
		l.setReplayPin(kind, line, nil)
	case "control_response":
		l.keepReplayResponse(line)
	}
}

func (l *lineLog) keepReplayResponse(line *entry) {
	var output struct {
		Response struct {
			ID      string `json:"request_id"`
			Subtype string `json:"subtype"`
		} `json:"response"`
	}
	if json.Unmarshal(line.message, &output) != nil {
		return
	}
	id := output.Response.ID
	request, ok := l.requests[id]
	if !ok {
		return
	}
	if request.line == l.input {
		if l.inputResponse == nil {
			l.inputResponse = line
			l.changePins(line, 1)
		}
		return
	}
	l.forgetReplayRequest(id)
	key := request.key
	if output.Response.Subtype == "error" {
		if key != "set_permission_mode" || !request.bypassAttempt {
			return
		}
		key = "bypass_blocked"
	}
	if previous := l.replayPins[key][1]; previous == nil || previous.seq < line.seq {
		l.setReplayPin(key, request.line, line)
	}
}

func (l *lineLog) setReplayPin(key string, first, second *entry) {
	for _, line := range l.replayPins[key] {
		l.changePins(line, -1)
	}
	if first == nil {
		delete(l.replayPins, key)
		return
	}
	l.replayPins[key] = [2]*entry{first, second}
	l.changePins(first, 1)
	l.changePins(second, 1)
}

func (l *lineLog) changePins(line *entry, delta int) {
	if line == nil {
		return
	}
	if line.pins == 0 {
		l.bytes -= line.size()
	}
	line.pins += delta
	if line.pins == 0 {
		l.bytes += line.size()
	}
}
