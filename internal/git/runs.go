package git

import "context"

type runIDKey struct{}

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
	context.AfterFunc(runCtx, func() { s.failAskpassRun(runID) })
	return runCtx, func() {
		s.unregisterStream(runID)
		cancel()
		s.failAskpassRun(runID)
	}, nil
}

func runIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(runIDKey{}).(string)
	return id
}
