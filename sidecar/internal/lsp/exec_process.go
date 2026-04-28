package lsp

import (
	"io"
	"os"
	"os/exec"
	"syscall"
)

type execProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser
}

func NewExecProcess(spec ProcessSpec) (ManagedProcess, error) {
	cmd := exec.Command(spec.Command, spec.Args...)
	cmd.Dir = spec.Cwd
	cmd.Env = os.Environ()

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	return &execProcess{
		cmd:    cmd,
		stdin:  stdin,
		stdout: stdout,
		stderr: stderr,
	}, nil
}

func (p *execProcess) PID() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

func (p *execProcess) Stdin() io.WriteCloser {
	return p.stdin
}

func (p *execProcess) Stdout() io.Reader {
	return p.stdout
}

func (p *execProcess) Stderr() io.Reader {
	return p.stderr
}

func (p *execProcess) Signal(signal os.Signal) error {
	if p.cmd.Process == nil {
		return os.ErrProcessDone
	}
	return p.cmd.Process.Signal(signal)
}

func (p *execProcess) Kill() error {
	if p.cmd.Process == nil {
		return os.ErrProcessDone
	}
	return p.cmd.Process.Kill()
}

func (p *execProcess) Wait() ProcessExit {
	err := p.cmd.Wait()
	return processExitFromState(p.cmd.ProcessState, err)
}

func processExitFromState(state *os.ProcessState, err error) ProcessExit {
	if state == nil {
		return ProcessExit{Err: err}
	}

	var exitCode *int
	var signal *string
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		signalValue := status.Signal().String()
		signal = &signalValue
	} else {
		code := state.ExitCode()
		exitCode = &code
	}

	return ProcessExit{
		ExitCode: exitCode,
		Signal:   signal,
		Err:      err,
	}
}
