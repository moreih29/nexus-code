package chat

import (
	"context"
	"sync"
)

// chatGate orders work like a mutex and lets a waiting RPC abandon its turn.
type chatGate struct {
	once sync.Once
	held chan struct{}
}

func (g *chatGate) Lock() {
	_ = g.lockContext(context.Background())
}

func (g *chatGate) lockContext(ctx context.Context) error {
	g.once.Do(func() { g.held = make(chan struct{}, 1) })
	select {
	case g.held <- struct{}{}:
		if err := ctx.Err(); err != nil {
			g.Unlock()
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (g *chatGate) Unlock() {
	<-g.held
}
