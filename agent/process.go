package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
)

var errProcessOutputLimit = errors.New("output exceeds capture limit")

// The caller owns the deadline, shared by every subprocess step. Errors omit
// argv and captured output because both can contain service credentials.
func captureProcess(ctx context.Context, argv []string, combined bool) ([]byte, error) {
	return captureProcessWithEnv(ctx, argv, combined, nil)
}

func captureProcessWithEnv(ctx context.Context, argv []string, combined bool, env []string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(argv) == 0 {
		return nil, errors.New("missing subprocess")
	}
	var stdout, stderr commandOutput
	process := exec.CommandContext(ctx, argv[0], argv[1:]...)
	process.Env = env
	process.WaitDelay = commandWaitDelay
	process.Stdout, process.Stderr = &stdout, &stderr
	if combined {
		process.Stderr = &stdout
	}
	err := process.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if stdout.overflow || stderr.overflow {
		return nil, fmt.Errorf("%w: output exceeds %d bytes", errProcessOutputLimit, commandMaxOutput)
	}
	if errors.Is(err, exec.ErrWaitDelay) {
		return nil, err
	}
	return stdout.buffer.Bytes(), err
}
