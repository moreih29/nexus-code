package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/fsops"
	"github.com/nexus-code/nexus-code/internal/proto"
)

const forceExitAfter = 75 * time.Millisecond

type server struct {
	dispatcher *dispatch.Dispatcher
	in         io.Reader
	out        io.Writer
	outMu      sync.Mutex
	wg         sync.WaitGroup
	ctx        context.Context
	cancel     context.CancelFunc
	termOnce   sync.Once
	accepting  bool
	acceptMu   sync.Mutex
}

func main() {
	root := rootPathFromArgv(os.Args)
	if root == "" {
		fmt.Fprintln(os.Stderr, "Usage: nexus-server <rootPath>")
		os.Exit(2)
	}

	fsys, err := fsops.New(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	d := dispatch.New()
	fsops.Register(d, fsys)
	s := newServer(d, os.Stdin, os.Stdout)
	s.installSigtermHandler()
	if err := s.writeFrame(proto.Ready()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	s.run()
}

func newServer(d *dispatch.Dispatcher, in io.Reader, out io.Writer) *server {
	ctx, cancel := context.WithCancel(context.Background())
	return &server{dispatcher: d, in: in, out: out, ctx: ctx, cancel: cancel, accepting: true}
}

func (s *server) installSigtermHandler() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGTERM)
	go func() {
		<-ch
		s.drainAndExit(0)
	}()
}

func (s *server) run() {
	scanner := bufio.NewScanner(s.in)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		if len(line) == 0 || !s.isAccepting() {
			continue
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handleLine(line)
		}()
	}
	if err := scanner.Err(); err != nil {
		id := proto.ProtocolErrorID
		_ = s.writeFrame(proto.ProtocolFailure(id, err.Error()))
	}
	s.drainAndExit(0)
}

func (s *server) handleLine(line []byte) {
	req, err := proto.ParseRequest(line)
	if err != nil {
		id := proto.IDFromParsedFrame(line)
		if id == "" {
			id = proto.IDFromMalformedLine(string(line))
		}
		if id == "" {
			id = proto.ProtocolErrorID
		}
		_ = s.writeFrame(proto.ProtocolFailure(id, protocolMessage(err)))
		return
	}
	_ = s.writeFrame(s.dispatcher.Dispatch(s.ctx, req))
}

func (s *server) writeFrame(frame any) error {
	data, err := proto.MarshalFrame(frame)
	if err != nil {
		return err
	}
	s.outMu.Lock()
	defer s.outMu.Unlock()
	_, err = s.out.Write(data)
	return err
}

func (s *server) isAccepting() bool {
	s.acceptMu.Lock()
	defer s.acceptMu.Unlock()
	return s.accepting
}

func (s *server) drainAndExit(code int) {
	s.termOnce.Do(func() {
		s.acceptMu.Lock()
		s.accepting = false
		s.acceptMu.Unlock()
		forceExit := time.AfterFunc(forceExitAfter, func() { os.Exit(code) })
		done := make(chan struct{})
		go func() {
			s.wg.Wait()
			close(done)
		}()
		select {
		case <-done:
			forceExit.Stop()
		case <-time.After(forceExitAfter):
			os.Exit(code)
		}
		s.cancel()
		os.Exit(code)
	})
}

func rootPathFromArgv(argv []string) string {
	if len(argv) > 1 {
		return argv[1]
	}
	return ""
}

func protocolMessage(err error) string {
	if _, ok := err.(proto.CodedError); ok {
		return err.Error()
	}
	return "malformed JSON"
}
