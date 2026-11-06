package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func processFixture(t *testing.T, mode string) []string {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ROBIN_TEST_COMMAND_HELPER", "1")
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	return []string{executable, "-test.run=^TestCommandExecutionHelper$", "--", mode}
}

func processTool(t *testing.T, name, mode string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Linux service CLI fixture")
	}
	argv := processFixture(t, mode)
	dir := t.TempDir()
	tool := filepath.Join(dir, name)
	t.Setenv("ROBIN_PROCESS_TEST_BINARY", argv[0])
	t.Setenv("ROBIN_PROCESS_TEST_MODE", mode)
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nexec \"$ROBIN_PROCESS_TEST_BINARY\" -test.run=^TestCommandExecutionHelper$ -- \"$ROBIN_PROCESS_TEST_MODE\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return tool
}

func TestProcessRejectsOverflowOnEitherStream(t *testing.T) {
	for _, mode := range []string{"overflow", "stderr-overflow"} {
		t.Run(mode, func(t *testing.T) {
			out, err := captureProcess(context.Background(), processFixture(t, mode), false)
			if out != nil || !errors.Is(err, errProcessOutputLimit) {
				t.Fatalf("partial oversized capture: bytes=%d err=%v", len(out), err)
			}
		})
	}
}

func TestProcessDeadlineIsSharedAcrossSteps(t *testing.T) {
	argv := processFixture(t, "short-sleep")
	ctx, cancel := context.WithTimeout(context.Background(), 450*time.Millisecond)
	defer cancel()
	if _, err := captureProcess(ctx, argv, false); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := captureProcess(ctx, argv, false); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second step must share the exhausted deadline: %v", err)
	}
	if time.Since(started) > 500*time.Millisecond {
		t.Fatal("second step received a fresh budget")
	}
}

func TestMetricsRejectsPartialCollection(t *testing.T) {
	for _, mode := range []string{"overflow", "stderr-overflow", "stall", "orphan"} {
		t.Run(mode, func(t *testing.T) {
			argv := processFixture(t, mode)
			previous := metricsCollectors["dovecot"]
			metricsCollectors["dovecot"] = []metricsSample{{field: "stats", argv: argv}}
			t.Cleanup(func() { metricsCollectors["dovecot"] = previous })
			var observation map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewDecoder(r.Body).Decode(&observation)
			}))
			defer server.Close()
			started := time.Now()
			pushServiceMetrics(context.Background(), server.Client(), config{adminURL: server.URL}, state{}, ownedService{ServiceID: "fixture", ServiceType: "dovecot"})
			if time.Since(started) > 17*time.Second {
				t.Fatal("collector exceeded its execution budget")
			}
			if observation["reachable"] != false || observation["errorCode"] != "collection_failed" {
				t.Fatalf("bounded failure reported as healthy: %v", observation)
			}
		})
	}
}

func TestOptionalMetricsOverflowFailsTheObservation(t *testing.T) {
	previous := metricsCollectors["dovecot"]
	metricsCollectors["dovecot"] = []metricsSample{
		{field: "stats", argv: processFixture(t, "short-sleep")},
		{field: "who", argv: processFixture(t, "overflow")},
	}
	t.Cleanup(func() { metricsCollectors["dovecot"] = previous })
	var observation map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&observation)
	}))
	defer server.Close()
	pushServiceMetrics(context.Background(), server.Client(), config{adminURL: server.URL}, state{}, ownedService{ServiceID: "fixture", ServiceType: "dovecot"})
	if observation["reachable"] != false || observation["errorCode"] != "collection_failed" || observation["stats"] != nil {
		t.Fatalf("optional overflow returned a partial healthy observation: %v", observation)
	}
}

func TestPostgresCaptureFailureIsRedacted(t *testing.T) {
	processTool(t, "psql", "stderr-overflow")
	var observation map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&observation)
	}))
	defer server.Close()
	pushServiceMetrics(context.Background(), server.Client(), config{adminURL: server.URL, postgresDSN: "fixture-secret"}, state{}, ownedService{ServiceID: "fixture", ServiceType: "postgres"})
	if observation["reachable"] != false || observation["errorCode"] != "collection_failed" {
		t.Fatalf("psql capture failure was accepted: %v", observation)
	}
}

func TestConfigFailureDoesNotClaimApplied(t *testing.T) {
	argv := processFixture(t, "overflow")
	applyRecipes["fixture"] = applyRecipe{validate: [][]string{argv}}
	t.Cleanup(func() { delete(applyRecipes, "fixture") })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"data":{"serviceType":"fixture","sha256":"new","files":[]}}`))
	}))
	defer server.Close()
	s := state{LastApplied: map[string]string{"fixture": "old"}}
	result := applyService(context.Background(), server.Client(), config{adminURL: server.URL}, s, ownedService{ServiceID: "fixture"})
	if result.status != "failed" || s.LastApplied["fixture"] != "old" {
		t.Fatalf("failed apply claimed success: %+v", result)
	}
}

func TestContainerCopyIsBoundedAndRedacted(t *testing.T) {
	for _, mode := range []string{"overflow", "fail", "sleep"} {
		t.Run(mode, func(t *testing.T) {
			tool := processTool(t, "docker", mode)
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			err := ensureContainerDir(ctx, tool, "fixture", "/etc/fixture")
			if err == nil || strings.Contains(err.Error(), "fixture-secret") {
				t.Fatalf("unbounded or unredacted copy failure: %v", err)
			}
		})
	}
}

func TestFailedLogCaptureKeepsThePosition(t *testing.T) {
	for _, name := range []string{"docker", "journalctl"} {
		for _, mode := range []string{"fail", "overflow"} {
			t.Run(name+"/"+mode, func(t *testing.T) {
				processTool(t, name, mode)
				svc := ownedService{ServiceID: "fixture", ServiceType: "postfix"}
				t.Setenv("ROBIN_AGENT_LOG_FIXTURE_FILE", filepath.Join(t.TempDir(), "missing"))
				key := "journald:postfix@-|"
				if name == "docker" {
					t.Setenv("ROBIN_AGENT_LOG_FIXTURE_CONTAINER", "fixture")
					key = "docker:fixture|"
				}
				cur := logCursor{Key: key, Source: "fixture", Since: time.Now().Add(-time.Minute).UTC(), Journal: "old-cursor"}
				batch, _, err := collectLogs(context.Background(), svc, &cur)
				if mode == "fail" {
					if err == nil {
						t.Fatalf("a failed read must be reported, got %+v", batch)
					}
					return
				}
				if err != nil || batch == nil || len(batch.Lines) != 0 || batch.Reset || batch.Next != cur {
					t.Fatalf("unreadable output moved the position: %+v, %v", batch, err)
				}
			})
		}
	}
}
func TestCapabilityProbeRejectsCaptureFailure(t *testing.T) {
	for _, mode := range []string{"overflow", "orphan", "sleep"} {
		t.Run(mode, func(t *testing.T) {
			argv := processFixture(t, mode)
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			if probeAction(ctx, config{}, "fixture", actionProbe{argv: argv, unavailable: "unknown"}) {
				t.Fatal("failed probe advertised an available action")
			}
		})
	}
}
