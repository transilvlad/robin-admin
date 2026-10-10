package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCommandExecutionHelper(t *testing.T) {
	if os.Getenv("ROBIN_TEST_COMMAND_HELPER") != "1" {
		return
	}
	switch os.Args[len(os.Args)-1] {
	case "sleep":
		time.Sleep(9 * time.Second)
	case "stall":
		time.Sleep(30 * time.Second)
	case "short-sleep":
		time.Sleep(300 * time.Millisecond)
		os.Exit(0)
	case "stderr-overflow":
		_, _ = os.Stderr.Write([]byte(strings.Repeat("x", commandMaxOutput+1)))
		os.Exit(0)
	case "fail":
		_, _ = os.Stderr.Write([]byte("fixture-secret"))
		os.Exit(1)
	case "child":
		time.Sleep(3 * time.Second)
	case "orphan":
		child := exec.Command(os.Args[0], "-test.run=^TestCommandExecutionHelper$", "--", "child")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	case "overflow":
		_, _ = os.Stdout.Write([]byte(strings.Repeat("x", commandMaxOutput+1)))
		os.Exit(0)
	case "at-limit":
		_, _ = os.Stdout.Write([]byte(strings.Repeat("x", commandMaxOutput)))
		os.Exit(0)
	case "cancelled-pipes":
		child := exec.Command(os.Args[0], "-test.run=^TestCommandExecutionHelper$", "--", "child")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Second)
	}
}

func commandExecutionFixture(t *testing.T, modes ...string) agentCommand {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ROBIN_TEST_COMMAND_HELPER", "1")
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	const action = "test.execution"
	commandSpecs[action] = commandSpec{"postfix", func(map[string]any) ([][]string, error) {
		var steps [][]string
		for _, mode := range modes {
			steps = append(steps, []string{executable, "-test.run=^TestCommandExecutionHelper$", "--", mode})
		}
		return steps, nil
	}}
	t.Cleanup(func() { delete(commandSpecs, action) })
	return agentCommand{ServiceType: "postfix", Action: action}
}

func TestCommandSharesTimeoutAcrossSteps(t *testing.T) {
	cmd := commandExecutionFixture(t, "sleep", "sleep")
	started := time.Now()
	_, err := runCommand(context.Background(), config{}, cmd)
	if err == nil {
		t.Fatal("steps exceeding the total execution budget must fail")
	}
	if elapsed := time.Since(started); elapsed > commandTimeout+2*time.Second {
		t.Fatalf("steps exceeded the shared timeout: %s", elapsed)
	}
}

func TestCommandBoundsInheritedOutputPipes(t *testing.T) {
	cmd := commandExecutionFixture(t, "orphan")
	started := time.Now()
	_, err := runCommand(context.Background(), config{}, cmd)
	if err == nil {
		t.Fatal("unclosed output must fail, not return partial success")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("wait for inherited pipes exceeded its bound: %s", elapsed)
	}
}

func TestCommandRejectsOversizedOutput(t *testing.T) {
	cmd := commandExecutionFixture(t, "overflow")
	output, err := runCommand(context.Background(), config{}, cmd)
	if err == nil || !strings.Contains(err.Error(), "output exceeds") {
		t.Fatalf("oversized output must fail explicitly, got output bytes=%d error=%v", len(output), err)
	}
	if output != "" {
		t.Fatal("oversized command must not return truncated successful output")
	}
}

func TestCommandAcceptsOutputAtTheLimit(t *testing.T) {
	cmd := commandExecutionFixture(t, "at-limit")
	output, err := runCommand(context.Background(), config{}, cmd)
	if err != nil || len(output) != commandMaxOutput {
		t.Fatalf("exact-limit output must succeed: bytes=%d error=%v", len(output), err)
	}
}

func TestCommandBoundsCancelledOutputPipes(t *testing.T) {
	cmd := commandExecutionFixture(t, "cancelled-pipes")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := runCommand(ctx, config{}, cmd)
	if err == nil || !strings.Contains(err.Error(), "context deadline exceeded") {
		t.Fatalf("cancelled execution must fail explicitly: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("cancelled inherited pipes exceeded their bound: %s", elapsed)
	}
}

func TestCommandOutputRetainsOnlyTheLimit(t *testing.T) {
	var output commandOutput
	for _, part := range []string{strings.Repeat("a", commandMaxOutput-1), "b", "c", "discarded"} {
		n, err := output.Write([]byte(part))
		if err != nil || n != len(part) {
			t.Fatalf("output must continue draining: written=%d error=%v", n, err)
		}
	}
	if !output.overflow || output.buffer.Len() != commandMaxOutput || output.buffer.Bytes()[commandMaxOutput-1] != 'b' {
		t.Fatal("output retention must stop at the exact byte limit")
	}
}

func TestCommandPollWaitsLongWhenRefused(t *testing.T) {
	previous := commandRefusedRetry
	commandRefusedRetry = 200 * time.Millisecond
	defer func() { commandRefusedRetry = previous }()
	var polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		polls.Add(1)
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"success":false,"error":"Probe-only agents cannot use the command channel"}`))
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	pollCommands(ctx, config{adminURL: server.URL}, state{AgentID: "probe", Credential: "fixture"}, &actionSet{actions: []string{"noop"}})
	// About one poll per refusal interval, not the error backoff's quick retries.
	if got := polls.Load(); got < 2 || got > 4 {
		t.Fatalf("polls while refused = %d, want 2-4", got)
	}
}
