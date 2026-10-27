package git

import "context"

type runIDKey struct{}

// startRun scopes one request that may prompt for credentials to runID.
// git.cancel with the id cancels the returned context, which kills the
// request's git, and askpass prompts the request leaves unanswered fail when
// the context ends, so their helpers exit and the host can close the
// dialogs. Callers must call done when the request finishes. An empty runID
// gives a plain child context.
func (s *Service) startRun(ctx context.Context, runID string) (runCtx context.Context, done context.CancelFunc, err error) {
	runCtx, cancel := context.WithCancel(ctx)
	if runID == "" {
		return runCtx, cancel, nil
	}
	if err := s.registerStream(runID, cancel); err != nil {
		cancel()
		return nil, nil, err
	}
	runCtx = context.WithValue(runCtx, runIDKey{}, runID)
	// A cancel fails the prompts at once, so the orphaned helpers exit and
	// the killed git's pipes close.
	context.AfterFunc(runCtx, func() { s.failAskpassRun(runID) })
	return runCtx, func() {
		// Unregistered first: handleAskpassConn refuses prompts for a run
		// that is not registered, so none can slip in after the last fail.
		s.unregisterStream(runID)
		cancel()
		s.failAskpassRun(runID)
	}, nil
}

// runIDFrom returns the run id startRun attached to ctx, if any.
func runIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(runIDKey{}).(string)
	return id
}
