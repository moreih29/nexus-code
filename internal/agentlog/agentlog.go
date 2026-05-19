// Package agentlog provides context helpers for the request-scoped slog.Logger
// that the stdioserver injects at the start of each request dispatch.
//
// Usage pattern:
//
//	// stdioserver: inject before calling Dispatch
//	ctx = agentlog.WithLogger(ctx, logger.With("correlationId", req.CorrelationID))
//
//	// handler: retrieve for request-local log entries
//	log := agentlog.FromContext(ctx)
//	log.Info("doing work")
//
// The package deliberately exposes only two functions so the dependency is as
// thin as possible — no concrete logger config belongs here.
package agentlog

import (
	"context"
	"log/slog"
)

// contextKey is an unexported type for the logger context key, preventing
// collisions with keys from other packages.
type contextKey struct{}

// WithLogger returns a child context carrying logger. The logger must already
// have the "src" marker attribute and any per-request attributes (e.g.
// correlationId) attached via slog.Logger.With before being passed here.
func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
	return context.WithValue(ctx, contextKey{}, logger)
}

// FromContext retrieves the request-scoped logger stored by WithLogger.
// When no logger is present (e.g. in unit tests that do not wire the full
// host), it returns slog.Default() so callers never receive a nil pointer.
func FromContext(ctx context.Context) *slog.Logger {
	if logger, ok := ctx.Value(contextKey{}).(*slog.Logger); ok && logger != nil {
		return logger
	}
	return slog.Default()
}
