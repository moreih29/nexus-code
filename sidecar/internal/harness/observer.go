package harness

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"nexus-code/sidecar/internal/contracts"
	"nexus-code/sidecar/internal/wsx"
)

const (
	TabBadgeEventType = "harness/tab-badge"
	ToolCallEventType = "harness/tool-call"
)

var (
	ErrServerNotConfigured  = errors.New("harness observer websocket server is not configured")
	ErrUnsupportedHookEvent = errors.New("unsupported harness hook event")
)

type Observer interface {
	SetServer(server wsx.Server)
	EmitTabBadge(ctx context.Context, event contracts.TabBadgeEvent) error
	EmitToolCall(ctx context.Context, event contracts.ToolCallEvent) error
	HandleHookEvent(ctx context.Context, input HookEventInput) (contracts.TabBadgeEvent, error)
}

type Clock func() time.Time

type Option func(*ServerObserver)

type ServerObserver struct {
	workspaceID        contracts.WorkspaceID
	defaultAdapterName string
	clock              Clock

	mu     sync.RWMutex
	server wsx.Server
}

// HookEventInput is the intentionally small hand-off contract between the
// future hook socket listener and this observer. It assumes Claude Code-like
// hook names (PreToolUse, Notification, Stop), but avoids depending on any
// concrete hook payload schema until T4 pins the socket/client format. Payload
// fields not needed for the tab badge are deliberately ignored here.
type HookEventInput struct {
	EventName        string
	NotificationType string
	SessionID        string
	AdapterName      string
	Timestamp        time.Time
	HasError         bool
	ErrorMessage     string
	ToolName         string
	ToolCallID       string
	InputSummary     string
	ResultSummary    string
	Message          string
}

func NewObserver(workspaceID contracts.WorkspaceID, opts ...Option) *ServerObserver {
	o := &ServerObserver{
		workspaceID: workspaceID,
		clock:       time.Now,
	}
	for _, opt := range opts {
		opt(o)
	}
	return o
}

func WithServer(server wsx.Server) Option {
	return func(o *ServerObserver) {
		o.server = server
	}
}

func WithDefaultAdapterName(adapterName string) Option {
	return func(o *ServerObserver) {
		o.defaultAdapterName = strings.TrimSpace(adapterName)
	}
}

func WithClock(clock Clock) Option {
	return func(o *ServerObserver) {
		if clock != nil {
			o.clock = clock
		}
	}
}

func (o *ServerObserver) SetServer(server wsx.Server) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.server = server
}

func (o *ServerObserver) HandleHookEvent(ctx context.Context, input HookEventInput) (contracts.TabBadgeEvent, error) {
	event, err := o.NormalizeHookEvent(input)
	if err == nil {
		if err := o.EmitTabBadge(ctx, event); err != nil {
			return event, err
		}
	} else if !errors.Is(err, ErrUnsupportedHookEvent) {
		return contracts.TabBadgeEvent{}, err
	}

	toolCallEvent, toolCallErr := o.NormalizeToolCallEvent(input)
	if toolCallErr == nil {
		if err := o.EmitToolCall(ctx, toolCallEvent); err != nil {
			return event, err
		}
	} else if !errors.Is(toolCallErr, ErrUnsupportedHookEvent) {
		return event, toolCallErr
	}

	if err != nil && toolCallErr != nil {
		if normalizedHookName(input.EventName) == "notification" {
			return contracts.TabBadgeEvent{}, nil
		}
		return contracts.TabBadgeEvent{}, err
	}
	return event, nil
}

func (o *ServerObserver) EmitTabBadge(ctx context.Context, event contracts.TabBadgeEvent) error {
	server := o.getServer()
	if server == nil {
		return ErrServerNotConfigured
	}
	return server.Send(ctx, event)
}

func (o *ServerObserver) EmitToolCall(ctx context.Context, event contracts.ToolCallEvent) error {
	server := o.getServer()
	if server == nil {
		return ErrServerNotConfigured
	}
	return server.Send(ctx, event)
}

func (o *ServerObserver) NormalizeHookEvent(input HookEventInput) (contracts.TabBadgeEvent, error) {
	state, err := tabBadgeStateForHook(input)
	if err != nil {
		return contracts.TabBadgeEvent{}, err
	}

	sessionID := strings.TrimSpace(input.SessionID)
	if sessionID == "" {
		return contracts.TabBadgeEvent{}, errors.New("harness hook event missing session id")
	}

	adapterName := strings.TrimSpace(input.AdapterName)
	if adapterName == "" {
		adapterName = o.defaultAdapterName
	}
	if adapterName == "" {
		return contracts.TabBadgeEvent{}, errors.New("harness hook event missing adapter name")
	}

	timestamp := input.Timestamp
	if timestamp.IsZero() {
		timestamp = o.clock()
	}

	return contracts.TabBadgeEvent{
		Type:        TabBadgeEventType,
		State:       state,
		SessionID:   sessionID,
		AdapterName: adapterName,
		WorkspaceID: o.workspaceID,
		Timestamp:   timestamp.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (o *ServerObserver) NormalizeToolCallEvent(input HookEventInput) (contracts.ToolCallEvent, error) {
	status, err := toolCallStatusForHook(input)
	if err != nil {
		return contracts.ToolCallEvent{}, err
	}

	sessionID := strings.TrimSpace(input.SessionID)
	if sessionID == "" {
		return contracts.ToolCallEvent{}, errors.New("harness tool call event missing session id")
	}

	adapterName := strings.TrimSpace(input.AdapterName)
	if adapterName == "" {
		adapterName = o.defaultAdapterName
	}
	if adapterName == "" {
		return contracts.ToolCallEvent{}, errors.New("harness tool call event missing adapter name")
	}

	timestamp := input.Timestamp
	if timestamp.IsZero() {
		timestamp = o.clock()
	}

	toolName := strings.TrimSpace(input.ToolName)
	if toolName == "" {
		switch status {
		case contracts.ToolCallStatusAwaitingApproval:
			toolName = "Permission"
		default:
			toolName = "Tool"
		}
	}

	return contracts.ToolCallEvent{
		Type:          ToolCallEventType,
		Status:        status,
		ToolName:      toolName,
		SessionID:     sessionID,
		AdapterName:   adapterName,
		WorkspaceID:   o.workspaceID,
		Timestamp:     timestamp.UTC().Format(time.RFC3339Nano),
		ToolCallID:    strings.TrimSpace(input.ToolCallID),
		InputSummary:  strings.TrimSpace(input.InputSummary),
		ResultSummary: strings.TrimSpace(input.ResultSummary),
		Message:       strings.TrimSpace(input.Message),
	}, nil
}

func (o *ServerObserver) getServer() wsx.Server {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return o.server
}

func tabBadgeStateForHook(input HookEventInput) (contracts.TabBadgeState, error) {
	if input.HasError || strings.TrimSpace(input.ErrorMessage) != "" {
		return contracts.TabBadgeStateError, nil
	}

	switch normalizedHookName(input.EventName) {
	case "pretooluse":
		return contracts.TabBadgeStateRunning, nil
	case "notification":
		if normalizedHookName(input.NotificationType) == "permissionprompt" {
			return contracts.TabBadgeStateAwaitingApproval, nil
		}
		return "", fmt.Errorf("%w: notification_type %q", ErrUnsupportedHookEvent, input.NotificationType)
	case "stop":
		return contracts.TabBadgeStateCompleted, nil
	case "error", "errored", "failure", "failed", "exception", "hookerror", "toolerror":
		return contracts.TabBadgeStateError, nil
	}

	name := normalizedHookName(input.EventName)
	if strings.Contains(name, "error") || strings.Contains(name, "fail") {
		return contracts.TabBadgeStateError, nil
	}
	return "", fmt.Errorf("%w: %q", ErrUnsupportedHookEvent, input.EventName)
}

func toolCallStatusForHook(input HookEventInput) (contracts.ToolCallStatus, error) {
	if input.HasError || strings.TrimSpace(input.ErrorMessage) != "" {
		return contracts.ToolCallStatusError, nil
	}

	switch normalizedHookName(input.EventName) {
	case "pretooluse":
		return contracts.ToolCallStatusStarted, nil
	case "posttooluse":
		return contracts.ToolCallStatusCompleted, nil
	case "notification":
		if normalizedHookName(input.NotificationType) == "permissionprompt" {
			return contracts.ToolCallStatusAwaitingApproval, nil
		}
		return "", fmt.Errorf("%w: notification_type %q", ErrUnsupportedHookEvent, input.NotificationType)
	case "stop":
		return "", fmt.Errorf("%w: %q", ErrUnsupportedHookEvent, input.EventName)
	case "stopfailure", "error", "errored", "failure", "failed", "exception", "hookerror", "toolerror":
		return contracts.ToolCallStatusError, nil
	}

	name := normalizedHookName(input.EventName)
	if strings.Contains(name, "error") || strings.Contains(name, "fail") {
		return contracts.ToolCallStatusError, nil
	}
	return "", fmt.Errorf("%w: %q", ErrUnsupportedHookEvent, input.EventName)
}

func normalizedHookName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	replacer := strings.NewReplacer("_", "", "-", "", " ", "", ".", "", "/", "")
	return replacer.Replace(name)
}
