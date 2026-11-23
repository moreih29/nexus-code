package lsp

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"time"
)

func (p *serverProcess) Shutdown(ctx context.Context) error {
	p.shutdownOnce.Do(func() {
		p.shutdownErr = p.doShutdown(ctx)
	})
	return p.shutdownErr
}

func (p *serverProcess) doShutdown(ctx context.Context) error {
	p.stopIdleTimer()
	p.markShuttingDown()
	if p.isExited() {
		return nil
	}

	requestCtx, cancel := context.WithTimeout(ctx, shutdownRequestTimeout)
	_, requestErr := p.request(requestCtx, "shutdown", nil)
	cancel()

	if ctx.Err() == nil {
		exitCtx, cancelExit := context.WithTimeout(ctx, shutdownExitGrace)
		if err := p.notify(exitCtx, "exit", nil); err == nil {
			select {
			case <-p.done:
				cancelExit()
				return requestErr
			case <-exitCtx.Done():
			}
		}
		cancelExit()
	}

	p.abortInput()
	if p.waitForExit(shutdownExitGrace) {
		return requestErr
	}
	return requestFailed("lsp server did not exit after shutdown")
}

func (p *serverProcess) forceClose() {
	p.stopIdleTimer()
	p.markShuttingDown()
	p.abortInput()
	p.waitForExit(shutdownExitGrace)
}

func (p *serverProcess) abortInput() {
	p.abortOnce.Do(func() {
		close(p.inputDone)
		if p.stopTree != nil {
			p.stopTree()
		}
		go func() { _ = p.stdin.Close() }()
	})
}

func (p *serverProcess) markShuttingDown() {
	p.mu.Lock()
	p.shuttingDown = true
	p.mu.Unlock()
}

func (p *serverProcess) resetIdleTimer() {
	if p.idleTimeout <= 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.exited || p.shuttingDown {
		return
	}
	if p.idleTimer == nil {
		p.idleTimer = time.AfterFunc(p.idleTimeout, func() {
			_ = p.Shutdown(context.Background())
		})
		return
	}
	p.idleTimer.Reset(p.idleTimeout)
}

func (p *serverProcess) stopIdleTimer() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.idleTimer != nil {
		p.idleTimer.Stop()
		p.idleTimer = nil
	}
}

func (p *serverProcess) waitLoop(drained <-chan struct{}) {
	exitObserved := observeServerExit(p.cmd.Process)
	var state *os.ProcessState
	var err error
	if !exitObserved {
		state, err = p.cmd.Process.Wait()
	}
	timer := time.NewTimer(outputDrainGrace)
	select {
	case <-drained:
	case <-timer.C:
	}
	timer.Stop()
	p.stopTree()
	if exitObserved {
		state, err = p.cmd.Process.Wait()
	}
	if err == nil && !state.Success() {
		err = &exec.ExitError{ProcessState: state}
	}
	_ = p.stdin.Close()
	_ = p.stdout.Close()
	_ = p.stderr.Close()
	p.markExited(err)
}

func (p *serverProcess) markExited(err error) {
	p.exitOnce.Do(func() {
		p.mu.Lock()
		p.exited = true
		p.exitErr = err
		shutdown := p.shuttingDown
		if p.idleTimer != nil {
			p.idleTimer.Stop()
			p.idleTimer = nil
		}
		internal := p.pendingInternal
		p.pendingInternal = make(map[string]chan rpcResponse)
		p.pendingServerRequests = make(map[string]json.RawMessage)
		p.pendingWatchedFileRegistrations = make(map[string][]watchedFileRegistration)
		p.watchedFileRegistrations = nil
		p.mu.Unlock()

		exitErr := requestFailed("lsp server exited")
		if err != nil {
			exitErr = requestFailed("lsp server exited: %s", err)
		}
		for _, ch := range internal {
			ch <- rpcResponse{Err: exitErr}
		}
		close(p.done)
		p.service.removeServer(p.id, p)

		reason := ""
		if err != nil {
			reason = err.Error()
		}
		_ = p.service.emit(EventServerExited, ServerExitedPayload{
			ServerID:   p.id,
			Reason:     reason,
			StderrTail: p.snapshotStderr(),
			Shutdown:   shutdown,
		})
	})
}

func (p *serverProcess) failInternal(err error) {
	p.mu.Lock()
	internal := p.pendingInternal
	p.pendingInternal = make(map[string]chan rpcResponse)
	p.mu.Unlock()
	for _, ch := range internal {
		ch <- rpcResponse{Err: err}
	}
}

func (p *serverProcess) deleteInternal(key string) {
	p.mu.Lock()
	delete(p.pendingInternal, key)
	p.mu.Unlock()
}

func (p *serverProcess) deleteServerRequest(agentRequestID string) {
	p.mu.Lock()
	delete(p.pendingServerRequests, agentRequestID)
	delete(p.pendingWatchedFileRegistrations, agentRequestID)
	p.mu.Unlock()
}

func (p *serverProcess) serverRequestCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.pendingServerRequests)
}

func (p *serverProcess) nextInternalID() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.internalSeq++
	return "__nexus_lsp_" + p.id + "_" + strconv.FormatUint(p.internalSeq, 10)
}

func (p *serverProcess) isExited() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exited
}

func (p *serverProcess) waitForExit(timeout time.Duration) bool {
	select {
	case <-p.done:
		return true
	case <-time.After(timeout):
		return false
	}
}
