package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func dockerJSONRecord(t *testing.T, text, stream string, at time.Time) string {
	t.Helper()
	record, err := json.Marshal(dockerJSONLogLine{Log: text, Stream: stream, Time: at.Format(time.RFC3339Nano)})
	if err != nil {
		t.Fatal(err)
	}
	return string(record)
}

func TestDockerJSONFragmentsAreEncryptedAndReassembledAfterRestart(t *testing.T) {
	now := time.Now().UTC()
	position := dockerLogCursor{FragmentVersion: 1}
	first, dropped, err := decodeDockerJSONLines("id", "service", []string{
		dockerJSONRecord(t, "password=pre", "stdout", now),
		dockerJSONRecord(t, "interleaved\n", "stderr", now.Add(time.Second)),
	}, &position, true)
	if err != nil || dropped != 0 || len(first) != 1 || first[0].line != "interleaved" {
		t.Fatalf("interleaved Docker streams were not kept separate: %+v, %d, %v", first, dropped, err)
	}
	cursor := logCursor{Key: "docker:test", Containers: map[string]dockerLogCursor{"id": position}}
	statePath := filepath.Join(t.TempDir(), "state.json")
	store := &logStateStore{}
	st, err := store.service(statePath, "service")
	if err != nil {
		t.Fatal(err)
	}
	st.Cursor = &cursor
	st.Pending = &logBatch{ID: "one", Sanitized: true, Next: cursor}
	st.PendingQueue = []*logBatch{{ID: "two", Sanitized: true, Next: cursor}}
	if err := store.save(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(logStatePath(statePath))
	if err != nil || strings.Contains(string(data), "password=pre") || !strings.Contains(string(data), `"encrypted"`) {
		t.Fatalf("Docker fragments were not encrypted in every cursor: %s, %v", data, err)
	}
	if st.Cursor.Containers["id"].Partials["stdout"].Text != "password=pre" ||
		st.Pending.Next.Containers["id"].Partials["stdout"].Text != "password=pre" {
		t.Fatal("saving encrypted state changed the in-memory cursors")
	}
	st, err = (&logStateStore{}).service(statePath, "service")
	if err != nil {
		t.Fatal(err)
	}
	position = st.Pending.Next.Containers["id"]
	lines, dropped, err := decodeDockerJSONLines("id", "service", []string{
		dockerJSONRecord(t, "review-secret\n", "stdout", now.Add(2*time.Second)),
	}, &position, false)
	if err != nil || dropped != 0 || len(lines) != 1 || lines[0].line != "password=prereview-secret" || !lines[0].historical {
		t.Fatalf("Docker fragment did not survive restart: %+v, %d, %v", lines, dropped, err)
	}
	if st.Cursor.Containers["id"].Partials["stdout"].Text != "password=pre" ||
		st.PendingQueue[0].Next.Containers["id"].Partials["stdout"].Text != "password=pre" {
		t.Fatal("decoding one queued cursor mutated another")
	}
	cfg, err := loadLogPipelineConfig("rspamd", "service")
	if err != nil {
		t.Fatal(err)
	}
	processed, _, _ := processLogPipelineWithHistory(
		[]string{"[service] " + lines[0].line}, []string{now.Format(time.RFC3339Nano)},
		[]string{"id"}, []bool{lines[0].historical}, false, cfg, logPipelineState{}, logCounters{}, now, false, nil)
	if len(processed) != 1 || strings.Contains(processed[0].line, "review-secret") ||
		!strings.Contains(processed[0].line, "password=[REDACTED]") || !processed[0].historical {
		t.Fatalf("reassembled historical line was not safely masked: %+v", processed)
	}
	if err := os.Remove(logStatePath(statePath) + ".key"); err != nil {
		t.Fatal(err)
	}
	if _, err := (&logStateStore{}).service(statePath, "service"); err == nil {
		t.Fatal("missing Docker fragment encryption key must fail explicitly")
	}
}

func TestDockerCursorRejectsInvalidStreamPositionsWithoutPartials(t *testing.T) {
	for _, streams := range []map[string]dockerStreamCursor{
		{"unknown": {}},
		{"stdout": {Seen: -1}},
		{"stderr": {ResumeSeen: -1}},
		{"stdout": {ResumeSkipped: -1}},
	} {
		cursor := logCursor{
			Key: "docker:test",
			Containers: map[string]dockerLogCursor{
				"id": {Streams: streams},
			},
		}
		if validLogCursor(&cursor) {
			t.Fatalf("invalid Docker stream cursor was accepted: %+v", streams)
		}
	}
}

func TestDockerJSONDropsUnknownAndOversizedFragments(t *testing.T) {
	now := time.Now().UTC()
	position := dockerLogCursor{FragmentVersion: 1, Partials: unknownDockerBoundaries(nil)}
	lines, dropped, err := decodeDockerJSONLines("id", "service", []string{
		dockerJSONRecord(t, "word=review-secret\n", "stdout", now),
		dockerJSONRecord(t, "safe\n", "stdout", now),
	}, &position, false)
	if err != nil || dropped != 1 || len(lines) != 1 || lines[0].line != "safe" {
		t.Fatalf("unknown initial Docker boundary escaped: %+v, %d, %v", lines, dropped, err)
	}
	position.Partials = nil
	lines, dropped, err = decodeDockerJSONLines("id", "service", []string{
		dockerJSONRecord(t, strings.Repeat("x", logRawEntryMaxBytes), "stdout", now),
		dockerJSONRecord(t, "password=review-secret", "stdout", now),
	}, &position, false)
	if err != nil || dropped != 1 || len(lines) != 0 || !position.Partials["stdout"].Discarding {
		t.Fatalf("oversized Docker fragment was not discarded: %d lines, %d, %v", len(lines), dropped, err)
	}
	lines, dropped, err = decodeDockerJSONLines("id", "service", []string{
		dockerJSONRecord(t, "-suffix\n", "stdout", now),
		dockerJSONRecord(t, "safe after overflow\n", "stdout", now),
	}, &position, false)
	if err != nil || dropped != 0 || len(lines) != 1 || lines[0].line != "safe after overflow" {
		t.Fatalf("Docker overflow leaked a suffix or lost the next line: %+v, %d, %v", lines, dropped, err)
	}
}

func TestContainerJSONLongRecordsAndFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	path := filepath.Join(dir, "container.json.log")
	record, err := json.Marshal(map[string]string{
		"log":  strings.Repeat("x", logLineMaxBytes+100) + "\n",
		"time": base.Add(time.Second).Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(record, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDockerFixture(t, dir, "long-id", "long-service", "json-file", path, base,
		fmt.Sprintf("%s fallback-entry\n", base.Add(2*time.Second).Format(time.RFC3339Nano)))
	writeDockerList(t, dir, "long-id")
	cur := &logCursor{
		Key: "docker:long-*", Source: "docker containers",
		Containers: map[string]dockerLogCursor{
			"long-id": {
				Name: "long-service", Since: base, DockerCursor: 1, Driver: "json-file", LogPath: path,
				FragmentVersion: 1,
				File:            &logCursor{Key: "docker-json-file:long-id", Path: path, Source: path},
			},
		},
	}
	batch, _, err := followContainerSet(context.Background(), cur.Key, "long-*", "", cur)
	if err != nil || len(batch.Lines) != 1 || !strings.Contains(batch.Lines[0], strings.Repeat("x", logLineMaxBytes)) {
		t.Fatalf("long JSON record was not decoded before truncation: %+v, %v", batch, err)
	}
	cfg, err := loadLogPipelineConfig("rspamd", "long")
	if err != nil {
		t.Fatal(err)
	}
	lines, _, _, counters := applyLogPipeline(batch.Lines, batch.Times, cfg, logPipelineState{}, logCounters{}, time.Now())
	if len(lines) != 1 || len(lines[0]) > logLineMaxBytes || counters.Truncated != 1 {
		t.Fatalf("long decoded record was not counted as truncated: %d lines, %+v", len(lines), counters)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	fallback, _, err := followContainerSet(context.Background(), cur.Key, "long-*", "", &batch.Next)
	if err != nil || len(fallback.Lines) != 1 || !strings.Contains(fallback.Lines[0], "fallback-entry") {
		t.Fatalf("unavailable JSON file did not fall back to docker logs: %+v, %v", fallback, err)
	}
}

func TestContainerLegacyCursorAndSelectorChange(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	path := filepath.Join(dir, "legacy.json.log")
	data := fmt.Sprintf("{\"log\":\"old-entry\\n\",\"time\":%q}\n{\"log\":\"new-entry\\n\",\"time\":%q}\n",
		base.Add(time.Second).Format(time.RFC3339Nano), base.Add(3*time.Second).Format(time.RFC3339Nano))
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDockerFixture(t, dir, "legacy-id", "legacy-service", "json-file", path, base, "")
	writeDockerFixture(t, dir, "new-id", "new-service", "local", "", base,
		fmt.Sprintf("%s initial-boundary\n%s selected-tail\n", base.Add(4*time.Second).Format(time.RFC3339Nano),
			base.Add(5*time.Second).Format(time.RFC3339Nano)))
	writeDockerList(t, dir, "legacy-id", "new-id")
	legacy := &logCursor{
		Key: "docker:legacy-service|", Source: "docker logs legacy-service",
		Since: base.Add(2 * time.Second), DockerSeen: 1, DockerCursor: 1,
	}
	batch, _, err := followContainerSet(context.Background(), "docker:containers|legacy-service|", "legacy-service", "", legacy)
	if err != nil || batch.Reset || len(batch.Lines) != 1 || !strings.Contains(batch.Lines[0], "new-entry") {
		t.Fatalf("legacy migration replayed previously read data: %+v, %v", batch, err)
	}
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_CONTAINER", "new-*")
	changed, _, err := collectLogs(context.Background(), ownedService{ServiceID: "selector", ServiceType: "rspamd"}, &batch.Next)
	if err != nil || !changed.Reset || len(changed.Lines) != 2 ||
		!strings.Contains(changed.Lines[0], "[REDACTED]") || !strings.Contains(changed.Lines[1], "selected-tail") {
		t.Fatalf("changed selector reused prior container positions: %+v, %v", changed, err)
	}
}

func TestContainerSelectorGlobsAndNewWorker(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	writeDockerFixture(t, dir, "smtp", "postal-smtp-1", "local", "", base,
		fmt.Sprintf("%s smtp\n", base.Format(time.RFC3339Nano)))
	writeDockerFixture(t, dir, "worker1", "postal-worker-1", "local", "", base,
		fmt.Sprintf("%s worker1\n", base.Format(time.RFC3339Nano)))
	writeDockerList(t, dir, "smtp", "worker1")

	first, _, err := followContainerSet(context.Background(), "docker:postal-*", "postal-*", "", nil)
	if err != nil || !first.Reset || len(first.Lines) != 2 {
		t.Fatalf("initial glob read = %+v, %v", first, err)
	}
	if first.Lines[0] != "[postal-smtp-1] [REDACTED] ambiguous Docker log line" ||
		first.Lines[1] != "[postal-worker-1] [REDACTED] ambiguous Docker log line" {
		t.Fatalf("containers were not time-ordered and tagged: %q", first.Lines)
	}

	newAt := base.Add(time.Second)
	writeDockerFixture(t, dir, "worker2", "postal-worker-2", "local", "", base,
		fmt.Sprintf("%s boundary\n%s worker2\n", newAt.Format(time.RFC3339Nano), newAt.Add(time.Second).Format(time.RFC3339Nano)))
	writeDockerList(t, dir, "smtp", "worker1", "worker2")
	next, _, err := followContainerSet(context.Background(), "docker:postal-*", "postal-*", "", &first.Next)
	if err != nil || next.Reset || !strings.Contains(strings.Join(next.Lines, "\n"), "[postal-worker-2] worker2") {
		t.Fatalf("new worker was not picked up without config changes: %+v, %v", next, err)
	}
}

func TestContainerAppearingAfterEmptyInitialDiscoveryStartsFromCreation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	writeDockerList(t, dir)
	first, _, err := followContainerSet(context.Background(), "docker:new-*", "new-*", "", nil)
	if err != nil || first == nil || !first.Reset || len(first.Next.Containers) != 0 {
		t.Fatalf("empty initial discovery did not establish the service cursor: %+v, %v", first, err)
	}
	statePath := filepath.Join(dir, "state.json")
	store := &logStateStore{}
	st, err := store.service(statePath, "service")
	if err != nil {
		t.Fatal(err)
	}
	st.Cursor = &first.Next
	if err := store.save(); err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(-time.Minute)
	logPath := filepath.Join(dir, "new-container.json.log")
	appendFile(t, logPath, dockerJSONRecord(t, "first line\n", "stdout", base.Add(time.Second))+"\n")
	writeDockerFixture(t, dir, "new-id", "new-worker", "json-file", logPath, base, "")
	writeDockerList(t, dir, "new-id")
	st, err = (&logStateStore{}).service(statePath, "service")
	if err != nil {
		t.Fatal(err)
	}
	next, _, err := followContainerSet(context.Background(), first.Next.Key, "new-*", "", st.Cursor)
	if err != nil || next.Reset || len(next.Lines) != 1 || next.Lines[0] != "[new-worker] first line" {
		t.Fatalf("new container was treated as another initial tail: %+v, %v", next, err)
	}
}

func TestDockerDiscoveryIsReusedWithinCollectionWindow(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	calls := filepath.Join(dir, "calls")
	t.Setenv("ROBIN_TEST_DOCKER_CALLS", calls)
	dockerPath := filepath.Join(dir, "docker")
	script, err := os.ReadFile(dockerPath)
	if err != nil {
		t.Fatal(err)
	}
	script = []byte(strings.Replace(string(script), "#!/bin/sh\n",
		"#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$ROBIN_TEST_DOCKER_CALLS\"\n", 1))
	if err := os.WriteFile(dockerPath, script, 0o755); err != nil {
		t.Fatal(err)
	}

	base := time.Now().UTC().Add(-time.Minute)
	path := filepath.Join(dir, "worker-one.json.log")
	var records strings.Builder
	for i := range 10001 {
		fmt.Fprintf(&records, "{\"log\":\"INFO entry-%d\\n\",\"stream\":\"stdout\",\"time\":%q}\n",
			i, base.Add(time.Duration(i)*time.Microsecond).Format(time.RFC3339Nano))
	}
	if err := os.WriteFile(path, []byte(records.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDockerFixture(t, dir, "worker-one-id", "worker-one", "json-file", path, base.Add(-time.Second), "")
	writeDockerList(t, dir, "worker-one-id")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_CONTAINER", "worker-*")
	svc := ownedService{ServiceID: "discovery", ServiceType: "rspamd"}
	cfg, err := loadLogPipelineConfig(svc.ServiceType, svc.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	cfg.rate, cfg.burst = 1000000, 1000000
	st := &logServiceState{Cursor: &logCursor{
		Key: "docker:containers|worker-*|", Source: "docker containers",
		Containers: map[string]dockerLogCursor{
			"worker-one-id": {
				Name: "worker-one", Since: base.Add(-time.Second), DockerCursor: 1,
				Driver: "json-file", LogPath: path, FragmentVersion: 1,
				File: &logCursor{Key: "docker-json-file:worker-one-id", Source: path, Path: path},
			},
		},
	}}
	batches, _, reads, err := collectPipelineBatches(context.Background(), svc, st, cfg, 3)
	if err != nil || reads != 3 || len(batches) == 0 || batches[len(batches)-1].Counters.Read != 10001 {
		t.Fatalf("multi-read collection failed: reads=%d batches=%d err=%v", reads, len(batches), err)
	}
	data, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(data), "ps\n") != 1 || strings.Count(string(data), "inspect\n") != 1 {
		t.Fatalf("Docker discovery repeated within one collection window: %q", data)
	}

	st.Cursor, st.Pipeline, st.Counters = &batches[len(batches)-1].Next, batches[len(batches)-1].Pipeline, batches[len(batches)-1].Counters
	newPath := filepath.Join(dir, "worker-two.json.log")
	if err := os.WriteFile(newPath, []byte(dockerJSONRecord(t, "INFO new worker\n", "stdout", base.Add(time.Second))+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDockerFixture(t, dir, "worker-two-id", "worker-two", "json-file", newPath, base, "")
	writeDockerList(t, dir, "worker-one-id", "worker-two-id")
	batches, _, _, err = collectPipelineBatches(context.Background(), svc, st, cfg, 1)
	if err != nil || len(batches) == 0 || !strings.Contains(strings.Join(batches[0].Lines, "\n"), "INFO new worker") {
		t.Fatalf("next collection window did not discover the new worker: %+v, %v", batches, err)
	}
	data, err = os.ReadFile(calls)
	if err != nil || strings.Count(string(data), "ps\n") != 2 || strings.Count(string(data), "inspect\n") != 3 {
		t.Fatalf("Docker discovery did not refresh in the next window: %q, %v", data, err)
	}
}

func TestDockerCollectionUsesTimeAfterReading(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	dockerPath := filepath.Join(dir, "docker")
	script, err := os.ReadFile(dockerPath)
	if err != nil {
		t.Fatal(err)
	}
	script = []byte(strings.Replace(string(script), "ps) cat", "ps) sleep 1; cat", 1))
	if err := os.WriteFile(dockerPath, script, 0o755); err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC().Add(500 * time.Millisecond)
	path := filepath.Join(dir, "worker.json.log")
	if err := os.WriteFile(path, []byte(dockerJSONRecord(t, "INFO arriving during read\n", "stdout", at)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDockerFixture(t, dir, "worker-id", "worker", "json-file", path, at.Add(-time.Minute), "")
	writeDockerList(t, dir, "worker-id")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_CONTAINER", "worker")
	svc := ownedService{ServiceID: "timing", ServiceType: "rspamd"}
	cfg, err := loadLogPipelineConfig(svc.ServiceType, svc.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	cfg.rate, cfg.burst = 1, 1
	st := &logServiceState{Cursor: &logCursor{
		Key: "docker:containers|worker|", Source: "docker containers",
		Containers: map[string]dockerLogCursor{
			"worker-id": {
				Name: "worker", Since: at.Add(-time.Minute), DockerCursor: 1,
				Driver: "json-file", LogPath: path, FragmentVersion: 1,
				File: &logCursor{Key: "docker-json-file:worker-id", Source: path, Path: path},
			},
		},
	}}
	batches, _, _, err := collectPipelineBatches(context.Background(), svc, st, cfg, 1)
	if err != nil || len(batches) != 1 {
		t.Fatalf("collection failed: %+v, %v", batches, err)
	}
	counters := batches[0].Counters
	if counters.UpdatedAt.Before(at) || counters.ReadLagMS <= 0 {
		t.Fatalf("collection used a timestamp from before the read: %+v; line time %s", counters, at)
	}
}

func TestDockerBacklogDoesNotHoldAnotherStreamsExpiredEntry(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(-time.Minute)
	quietPath, busyPath := filepath.Join(dir, "quiet.json.log"), filepath.Join(dir, "busy.json.log")
	if err := os.WriteFile(quietPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	record := dockerJSONRecord(t, "INFO busy\n", "stdout", base.Add(time.Second)) + "\n"
	if err := os.WriteFile(busyPath, []byte(strings.Repeat(record, logBatchMaxLines/2+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDockerFixture(t, dir, "quiet-id", "worker-quiet", "json-file", quietPath, base, "")
	writeDockerFixture(t, dir, "busy-id", "worker-busy", "json-file", busyPath, base, "")
	writeDockerList(t, dir, "quiet-id", "busy-id")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_CONTAINER", "worker-*")
	svc := ownedService{ServiceID: "independent-streams", ServiceType: "rspamd"}
	cfg, err := loadLogPipelineConfig(svc.ServiceType, svc.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	cfg.rate, cfg.burst = 1000000, 1000000
	position := func(id, name, path string) dockerLogCursor {
		return dockerLogCursor{
			Name: name, Since: base, DockerCursor: 1, Driver: "json-file", LogPath: path, FragmentVersion: 1,
			File: &logCursor{Key: "docker-json-file:" + id, Source: path, Path: path},
		}
	}
	held := "2026-11-10 14:15:25 ERROR quiet"
	st := &logServiceState{
		Cursor: &logCursor{
			Key: "docker:containers|worker-*|", Source: "docker containers",
			Containers: map[string]dockerLogCursor{
				"quiet-id": position("quiet-id", "worker-quiet", quietPath),
				"busy-id":  position("busy-id", "worker-busy", busyPath),
			},
		},
		Pipeline: logPipelineState{Streams: map[string]logStreamState{
			"quiet-id": {
				HeldOpen: true, HeldLine: held, HeldRaw: held, HeldLines: 1,
				HeldSince: time.Now().Add(-3 * time.Second), HeldMaskConfig: logMaskFingerprint(cfg),
			},
		}},
	}
	batches, more, _, err := collectPipelineBatches(context.Background(), svc, st, cfg, 1)
	if err != nil || !more || len(batches) == 0 || !strings.Contains(strings.Join(batches[0].Lines, "\n"), held) {
		t.Fatalf("busy stream prevented an idle stream from flushing: more=%v batches=%d err=%v", more, len(batches), err)
	}
}

func TestDockerPartialKeepsPreviousMultilineEntryOpen(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(-time.Minute)
	path := filepath.Join(dir, "worker.json.log")
	if err := os.WriteFile(path, []byte(dockerJSONRecord(t, "  at ", "stdout", base.Add(time.Second))+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDockerFixture(t, dir, "worker-id", "worker", "json-file", path, base, "")
	writeDockerList(t, dir, "worker-id")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_CONTAINER", "worker")
	svc := ownedService{ServiceID: "fragment-continuation", ServiceType: "rspamd"}
	cfg, err := loadLogPipelineConfig(svc.ServiceType, svc.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	held := "[worker] 2026-11-10 14:15:25 ERROR failed"
	st := &logServiceState{
		Cursor: &logCursor{
			Key: "docker:containers|worker|", Source: "docker containers",
			Containers: map[string]dockerLogCursor{
				"worker-id": {
					Name: "worker", Since: base, DockerCursor: 1, Driver: "json-file", LogPath: path, FragmentVersion: 1,
					File: &logCursor{Key: "docker-json-file:worker-id", Source: path, Path: path},
				},
			},
		},
		Pipeline: logPipelineState{Streams: map[string]logStreamState{
			"worker-id": {
				HeldOpen: true, HeldLine: held, HeldRaw: held, HeldLines: 1,
				HeldSince: time.Now().Add(-3 * time.Second), HeldMaskConfig: logMaskFingerprint(cfg),
			},
		}},
	}
	batches, more, _, err := collectPipelineBatches(context.Background(), svc, st, cfg, 1)
	if err != nil || more || len(batches) != 1 || len(batches[0].Lines) != 0 ||
		!batches[0].Pipeline.Streams["worker-id"].HeldOpen {
		t.Fatalf("unfinished Docker line allowed its preceding entry to expire: %+v, %v", batches, err)
	}
	st.Cursor, st.Pipeline, st.Counters = &batches[0].Next, batches[0].Pipeline, batches[0].Counters
	appendFile(t, path, dockerJSONRecord(t, "worker.rb:42\n", "stdout", base.Add(2*time.Second))+"\n")
	appendFile(t, path, dockerJSONRecord(t, "2026-11-10 14:15:26 INFO recovered\n", "stdout", base.Add(3*time.Second))+"\n")
	batches, _, _, err = collectPipelineBatches(context.Background(), svc, st, cfg, 1)
	if err != nil || len(batches) != 1 || len(batches[0].Lines) != 1 ||
		batches[0].Lines[0] != held+"\n[worker]   at worker.rb:42" {
		t.Fatalf("Docker continuation was split from its entry: %+v, %v", batches, err)
	}
}

func TestContainerSetRejectsMoreStreamsThanCanBeReadSafely(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	writeDockerList(t, dir)
	cur := &logCursor{Key: "docker:many", Containers: make(map[string]dockerLogCursor)}
	for i := 0; i <= logBatchMaxLines; i++ {
		cur.Containers[fmt.Sprintf("id-%d", i)] = dockerLogCursor{Name: "gone"}
	}
	if _, _, err := followContainerSet(context.Background(), cur.Key, "*", "", cur); err == nil {
		t.Fatal("collector must not advance cursors for streams beyond the window")
	}
}

func TestContainerRecreationDrainsOldIDAndReadsNewFromCreation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	writeDockerFixture(t, dir, "worker-old", "postal-worker-1", "local", "", base,
		fmt.Sprintf("%s before\n", base.Format(time.RFC3339Nano)))
	writeDockerList(t, dir, "worker-old")
	first, _, err := followContainerSet(context.Background(), "docker:postal-*", "postal-*", "", nil)
	if err != nil {
		t.Fatal(err)
	}

	appendDockerLog(t, dir, "worker-old", fmt.Sprintf("%s between\n", base.Format(time.RFC3339Nano)))
	created := base.Add(time.Second)
	writeDockerFixture(t, dir, "worker-new", "postal-worker-1", "local", "", created,
		fmt.Sprintf("%s boundary\n%s after-recreate\n", created.Add(time.Second).Format(time.RFC3339Nano),
			created.Add(2*time.Second).Format(time.RFC3339Nano)))
	writeDockerList(t, dir, "worker-new")
	next, _, err := followContainerSet(context.Background(), "docker:postal-*", "postal-*", "", &first.Next)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(next.Lines, "\n")
	if !strings.Contains(got, "[postal-worker-1] between") || !strings.Contains(got, "[postal-worker-1] after-recreate") {
		t.Fatalf("recreation lost readable old or new container lines: %q", got)
	}
	if len(next.Next.Containers) != 2 {
		t.Fatalf("old container cursor should remain until its final drain: %+v", next.Next.Containers)
	}
}

func TestJSONFileContainerUsesDirectLogPathAndFollowsRotations(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	logPath := filepath.Join(dir, "docker-json.log")
	if err := os.WriteFile(logPath, []byte(fmt.Sprintf("{\"log\":\"boundary\\n\",\"time\":%q,\"stream\":\"stdout\"}\n{\"log\":\"first\\n\",\"time\":%q,\"stream\":\"stdout\"}\n", base.Add(-time.Second).Format(time.RFC3339Nano), base.Format(time.RFC3339Nano))), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDockerFixture(t, dir, "json-id", "postal-json-1", "json-file", logPath, base, "")
	writeDockerList(t, dir, "json-id")
	first, _, err := followContainerSet(context.Background(), "docker:postal-json-*", "postal-json-*", "", nil)
	if err != nil || len(first.Lines) != 2 || first.Lines[0] != "[postal-json-1] boundary" ||
		first.Lines[1] != "[postal-json-1] first" {
		t.Fatalf("direct json-file read = %+v, %v", first, err)
	}
	if first.Next.Containers["json-id"].File == nil {
		t.Fatal("json-file inode and byte offset were not persisted")
	}
	appendFile(t, logPath, fmt.Sprintf("{\"log\":\"behind\\n\",\"time\":%q,\"stream\":\"stdout\"}\n", base.Add(time.Second).Format(time.RFC3339Nano)))
	if err := os.Rename(logPath, logPath+".1"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath, []byte(fmt.Sprintf("{\"log\":\"second\\n\",\"time\":%q,\"stream\":\"stdout\"}\n", base.Add(2*time.Second).Format(time.RFC3339Nano))), 0o600); err != nil {
		t.Fatal(err)
	}
	cursor := first.Next
	var lines []string
	for more := true; more; {
		var next *logBatch
		next, more, err = followContainerSet(context.Background(), "docker:postal-json-*", "postal-json-*", "", &cursor)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, next.Lines...)
		cursor = next.Next
	}
	if len(lines) != 2 || lines[0] != "[postal-json-1] behind" || lines[1] != "[postal-json-1] second" {
		t.Fatalf("rotated json-file read = %q", lines)
	}
}

func TestNewJSONContainerStartsAtTheBeginningOfEachStream(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(-time.Minute)
	logPath := filepath.Join(dir, "new-container.json.log")
	appendFile(t, logPath,
		dockerJSONRecord(t, "first stdout\n", "stdout", base.Add(time.Second))+"\n"+
			dockerJSONRecord(t, "first stderr\n", "stderr", base.Add(2*time.Second))+"\n")
	writeDockerFixture(t, dir, "new-id", "new-worker", "json-file", logPath, base, "")
	writeDockerList(t, dir, "new-id")
	cursor := logCursor{Key: "docker:new-*", Containers: map[string]dockerLogCursor{}}
	batch, _, err := followContainerSet(context.Background(), cursor.Key, "new-*", "", &cursor)
	if err != nil || len(batch.Lines) != 2 || batch.Lines[0] != "[new-worker] first stdout" ||
		batch.Lines[1] != "[new-worker] first stderr" {
		t.Fatalf("new container lost the beginning of a stream: %+v, %v", batch, err)
	}
}

func TestEmptyInitialJSONTailKeepsFirstLiveRecord(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(-time.Minute)
	logPath := filepath.Join(dir, "empty-container.json.log")
	if err := os.WriteFile(logPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	writeDockerFixture(t, dir, "id", "worker", "json-file", logPath, base, "")
	writeDockerList(t, dir, "id")
	first, _, err := followContainerSet(context.Background(), "docker:worker", "worker", "", nil)
	if err != nil || !first.Reset || len(first.Lines) != 0 {
		t.Fatalf("initial empty tail failed: %+v, %v", first, err)
	}
	appendFile(t, logPath, dockerJSONRecord(t, "first live line\n", "stdout", time.Now())+"\n")
	next, _, err := followContainerSet(context.Background(), first.Next.Key, "worker", "", &first.Next)
	if err != nil || len(next.Lines) != 1 || next.Lines[0] != "[worker] first live line" {
		t.Fatalf("first live line after an empty tail was lost: %+v, %v", next, err)
	}
}

func TestNewJSONContainerReadsAvailableRotationsFromOldest(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(-time.Minute)
	logPath := filepath.Join(dir, "new-container.json.log")
	appendFile(t, logPath+".2",
		dockerJSONRecord(t, "oldest boundary\n", "stdout", base.Add(time.Second))+"\n"+
			dockerJSONRecord(t, "oldest retained\n", "stdout", base.Add(2*time.Second))+"\n")
	appendFile(t, logPath+".1", dockerJSONRecord(t, "middle retained\n", "stdout", base.Add(3*time.Second))+"\n")
	appendFile(t, logPath, dockerJSONRecord(t, "newest retained\n", "stdout", base.Add(4*time.Second))+"\n")
	writeDockerFixture(t, dir, "new-id", "new-worker", "json-file", logPath, base, "",
		`{"max-size":"1k","max-file":"4"}`)
	writeDockerList(t, dir, "new-id")
	cursor := logCursor{Key: "docker:new-*", Containers: map[string]dockerLogCursor{}}
	var lines []string
	for more, i := true, 0; more && i < 5; i++ {
		batch, nextMore, err := followContainerSet(context.Background(), cursor.Key, "new-*", "", &cursor)
		if err != nil {
			t.Fatal(err)
		}
		lines, cursor, more = append(lines, batch.Lines...), batch.Next, nextMore
	}
	joined := strings.Join(lines, "\n")
	for _, line := range []string{"oldest boundary", "oldest retained", "middle retained", "newest retained"} {
		if !strings.Contains(joined, line) {
			t.Fatalf("new container skipped an available rotated file: %q", lines)
		}
	}
}

func TestNewJSONContainerDiscardsUnknownOldestRotationBoundary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(-time.Minute)
	logPath := filepath.Join(dir, "new-container.json.log")
	appendFile(t, logPath+".2",
		dockerJSONRecord(t, "word=review-secret\n", "stdout", base.Add(time.Second))+"\n"+
			dockerJSONRecord(t, "safe oldest\n", "stdout", base.Add(2*time.Second))+"\n")
	appendFile(t, logPath+".1", dockerJSONRecord(t, "safe middle\n", "stdout", base.Add(3*time.Second))+"\n")
	appendFile(t, logPath, dockerJSONRecord(t, "safe newest\n", "stdout", base.Add(4*time.Second))+"\n")
	writeDockerFixture(t, dir, "new-id", "new-worker", "json-file", logPath, base, "",
		`{"max-size":"1k","max-file":"3"}`)
	writeDockerList(t, dir, "new-id")
	cursor := logCursor{Key: "docker:new-*", Containers: map[string]dockerLogCursor{}}
	var lines []string
	var dropped uint64
	for more, i := true, 0; more && i < 5; i++ {
		batch, nextMore, err := followContainerSet(context.Background(), cursor.Key, "new-*", "", &cursor)
		if err != nil {
			t.Fatal(err)
		}
		lines, cursor, more = append(lines, batch.Lines...), batch.Next, nextMore
		dropped += batch.InputDropped
	}
	joined := strings.Join(lines, "\n")
	if dropped != 1 || strings.Contains(joined, "review-secret") || !strings.Contains(joined, "safe oldest") ||
		!strings.Contains(joined, "safe middle") || !strings.Contains(joined, "safe newest") {
		t.Fatalf("unknown rotation boundary leaked or lost safe records: %q, dropped=%d", lines, dropped)
	}
}

func TestDockerJSONFragmentSurvivesRotationAndRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(-time.Minute)
	path := filepath.Join(dir, "docker-json.log")
	appendFile(t, path, dockerJSONRecord(t, "password=review-", "stdout", base.Add(time.Second))+"\n"+
		dockerJSONRecord(t, "other stream\n", "stderr", base.Add(2*time.Second))+"\n")
	writeDockerFixture(t, dir, "id", "service", "json-file", path, base, "")
	writeDockerList(t, dir, "id")
	cursor := logCursor{
		Key: "docker:service", Containers: map[string]dockerLogCursor{
			"id": {Name: "service", Since: base, DockerCursor: 1, FragmentVersion: 1,
				File: &logCursor{Key: "docker-json-file:id", Source: path, Path: path}},
		},
	}
	first, _, err := followContainerSet(context.Background(), cursor.Key, "service", "", &cursor)
	if err != nil || len(first.Lines) != 1 || first.Lines[0] != "[service] other stream" ||
		first.Next.Containers["id"].Partials["stdout"].Text != "password=review-" {
		t.Fatalf("Docker partial was not held independently: %+v, %v", first, err)
	}
	if len(cursor.Containers["id"].Partials) != 0 {
		t.Fatal("reading Docker fragments mutated the acknowledged cursor")
	}
	statePath := filepath.Join(dir, "state.json")
	store := &logStateStore{}
	st, err := store.service(statePath, "service")
	if err != nil {
		t.Fatal(err)
	}
	st.Cursor = &first.Next
	if err := store.save(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, dockerJSONRecord(t, "secret\n", "stdout", base.Add(3*time.Second))+"\n")
	st, err = (&logStateStore{}).service(statePath, "service")
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for more, i := true, 0; more && i < 4; i++ {
		batch, nextMore, err := followContainerSet(context.Background(), cursor.Key, "service", "", st.Cursor)
		if err != nil {
			t.Fatal(err)
		}
		lines, st.Cursor, more = append(lines, batch.Lines...), &batch.Next, nextMore
	}
	cfg, err := loadLogPipelineConfig("rspamd", "service")
	if err != nil {
		t.Fatal(err)
	}
	masked, _, _, _ := applyLogPipeline(lines, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	if len(masked) != 1 || !strings.Contains(masked[0], "password=[REDACTED]") || strings.Contains(masked[0], "review-secret") {
		t.Fatalf("rotated Docker fragments leaked or were lost: %q", masked)
	}
}

func TestDockerResetFragmentRemainsHistoricalAfterRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(-time.Minute)
	path := filepath.Join(dir, "docker-json.log")
	appendFile(t, path, dockerJSONRecord(t, "boundary\n", "stdout", base)+"\n"+
		dockerJSONRecord(t, "password=review-", "stdout", base.Add(time.Second))+"\n")
	writeDockerFixture(t, dir, "id", "service", "json-file", path, base, "")
	writeDockerList(t, dir, "id")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_CONTAINER", "service")
	svc := ownedService{ServiceID: "service", ServiceType: "rspamd"}
	first, _, err := collectLogs(context.Background(), svc, nil)
	if err != nil || !first.Reset || len(first.Lines) != 1 || first.Lines[0] != "[service] boundary" ||
		first.Next.Containers["id"].Partials["stdout"].Text != "password=review-" {
		t.Fatalf("initial Docker fragment was not held: %+v, %v", first, err)
	}
	statePath := filepath.Join(dir, "state.json")
	store := &logStateStore{}
	st, err := store.service(statePath, svc.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	st.Cursor = &first.Next
	if err := store.save(); err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, dockerJSONRecord(t, "secret\n", "stdout", base.Add(2*time.Second))+"\n")
	st, err = (&logStateStore{}).service(statePath, svc.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := loadLogPipelineConfig("rspamd", svc.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	batches, _, _, err := collectPipelineBatches(context.Background(), svc, st, cfg, 1)
	if err != nil || len(batches) != 1 || !batches[0].Reset || !batches[0].ResetAppend ||
		len(batches[0].Lines) != 1 || !strings.Contains(batches[0].Lines[0], "password=[REDACTED]") {
		t.Fatalf("reset fragment entered live history or was not masked: %+v, %v", batches, err)
	}
}

func TestDockerFallbackKeepsStreamsSeparateAndDoesNotShipFragments(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	stamp := func(offset time.Duration) string { return base.Add(offset).Format(time.RFC3339Nano) }
	writeDockerFixture(t, dir, "id", "service", "local", "", base,
		fmt.Sprintf("%s safe-before\n%s pass%s word=review-secret\n%s pass", stamp(time.Second),
			stamp(2*time.Second), stamp(3*time.Second), stamp(4*time.Second)))
	if err := os.WriteFile(filepath.Join(dir, "id.err"), []byte(fmt.Sprintf("%s stderr-safe\n", stamp(3*time.Second))), 0o600); err != nil {
		t.Fatal(err)
	}
	position := dockerLogCursor{
		Name: "service", Since: base, DockerCursor: 1,
		Streams: map[string]dockerStreamCursor{
			"stdout": {Since: base},
			"stderr": {Since: base},
		},
	}
	lines, _, dropped, masked, err := readDockerFallback(context.Background(), "id", "service", &position, false, false, 0, 1<<20, 100)
	var output []string
	for _, line := range lines {
		output = append(output, line.line)
	}
	if err != nil || dropped != 1 || masked != 1 || !position.Streams["stdout"].Discard ||
		!strings.Contains(strings.Join(output, "\n"), "stderr-safe") ||
		strings.Contains(strings.Join(output, "\n"), "review-secret") {
		t.Fatalf("Docker fallback exposed a fragment or merged streams: %q, dropped=%d masked=%d, %v", output, dropped, masked, err)
	}
	statePath := filepath.Join(dir, "state.json")
	store := &logStateStore{}
	st, err := store.service(statePath, "service")
	if err != nil {
		t.Fatal(err)
	}
	st.Cursor = &logCursor{Key: "docker:test", Containers: map[string]dockerLogCursor{"id": position}}
	if err := store.save(); err != nil {
		t.Fatal(err)
	}
	appendDockerLog(t, dir, "id", "word=review-secret\n"+stamp(5*time.Second)+" safe-after\n")
	if err := os.WriteFile(filepath.Join(dir, "id.err"), []byte(fmt.Sprintf("%s stderr-safe\n%s stderr-next\n",
		stamp(3*time.Second), stamp(5*time.Second))), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err = (&logStateStore{}).service(statePath, "service")
	if err != nil {
		t.Fatal(err)
	}
	position = st.Cursor.Containers["id"]
	lines, _, dropped, _, err = readDockerFallback(context.Background(), "id", "service", &position, false, false, 0, 1<<20, 100)
	output = nil
	for _, line := range lines {
		output = append(output, line.line)
	}
	joined := strings.Join(output, "\n")
	if err != nil || dropped != 0 || position.Streams["stdout"].Discard ||
		strings.Contains(joined, "review-secret") || !strings.Contains(joined, "safe-after") || !strings.Contains(joined, "stderr-next") {
		t.Fatalf("Docker fallback did not safely resume after restart: %q, dropped=%d, %v", output, dropped, err)
	}
}

func TestDockerFallbackRetainsIncompleteLineWatermarkUntilCompletion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(-time.Minute)
	at := base.Add(10 * time.Second)
	writeDockerFixture(t, dir, "id", "service", "local", "", base,
		at.Format(time.RFC3339Nano)+" pass")
	position := dockerLogCursor{
		Name: "service", Since: base, DockerCursor: 1,
		Streams: map[string]dockerStreamCursor{
			"stdout": {Since: base},
			"stderr": {Since: base},
		},
	}
	_, _, dropped, _, err := readDockerFallback(context.Background(), "id", "service", &position, false, false, 0, 1<<20, 100)
	stdout := position.Streams["stdout"]
	if err != nil || dropped != 1 || !stdout.Discard || !stdout.Since.Equal(at) || stdout.Seen != 1 {
		t.Fatalf("incomplete line lost its inclusive watermark: %+v, dropped=%d, %v", stdout, dropped, err)
	}
	next := time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	appendDockerLog(t, dir, "id", "word=review-secret\n"+next+" safe-after\n")
	lines, _, dropped, _, err := readDockerFallback(context.Background(), "id", "service", &position, false, false, 0, 1<<20, 100)
	if err != nil || dropped != 0 || len(lines) != 1 || lines[0].line != "safe-after" ||
		position.Streams["stdout"].Discard {
		t.Fatalf("completed incomplete line prevented later logs from resuming: %+v, dropped=%d, %v", lines, dropped, err)
	}
}

func TestDockerFallbackToDirectKeepsPerStreamPositions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Docker fixture uses a shell")
	}
	dir := setupFakeDocker(t)
	base := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	at := base.Add(time.Second)
	path := filepath.Join(dir, "docker-json.log")
	writeDockerFixture(t, dir, "id", "service", "json-file", path, base,
		fmt.Sprintf("%s stdout-entry\n", at.Format(time.RFC3339Nano)))
	if err := os.WriteFile(filepath.Join(dir, "id.err"), []byte(fmt.Sprintf("%s stderr-entry\n", at.Format(time.RFC3339Nano))), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDockerList(t, dir, "id")
	position := dockerLogCursor{
		Name: "service", Since: base, DockerCursor: 1,
		Streams: map[string]dockerStreamCursor{
			"stdout": {Since: base},
			"stderr": {Since: base},
		},
	}
	first, more, _, _, err := readDockerFallback(context.Background(), "id", "service", &position, false, false, 0, 1<<20, 1)
	if err != nil || !more || len(first) != 1 {
		t.Fatalf("first bounded fallback read: %+v, more=%t, %v", first, more, err)
	}
	position.Since, position.Seen = first[0].at, 1
	appendFile(t, path, dockerJSONRecord(t, "stdout-entry\n", "stdout", at)+"\n"+
		dockerJSONRecord(t, "stderr-entry\n", "stderr", at)+"\n")
	cursor := logCursor{Key: "docker:service", Containers: map[string]dockerLogCursor{"id": position}}
	second, _, err := followContainerSet(context.Background(), cursor.Key, "service", "", &cursor)
	if err != nil || len(second.Lines) != 1 || strings.Contains(second.Lines[0], first[0].line) {
		t.Fatalf("transition replayed a line or skipped the other stream: first=%+v second=%+v, %v", first, second, err)
	}
	last, _, err := followContainerSet(context.Background(), cursor.Key, "service", "", &second.Next)
	if err != nil || len(last.Lines) != 0 {
		t.Fatalf("transition replayed direct records: %+v, %v", last, err)
	}
}

func setupFakeDocker(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	script := `#!/bin/sh
case "$1" in
  ps) cat "$ROBIN_TEST_DOCKER_LIST" ;;
  inspect) id="$4"; awk -F '\t' -v id="$id" '$1 == id { print; found=1 } END { if (!found) exit 1 }' "$ROBIN_TEST_DOCKER_INFO" ;;
  logs) for arg in "$@"; do id="$arg"; done; cat "$ROBIN_TEST_DOCKER_LOG_DIR/$id.log"; if [ -f "$ROBIN_TEST_DOCKER_LOG_DIR/$id.err" ]; then cat "$ROBIN_TEST_DOCKER_LOG_DIR/$id.err" >&2; fi ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ROBIN_TEST_DOCKER_DIR", dir)
	t.Setenv("ROBIN_TEST_DOCKER_INFO", filepath.Join(dir, "containers.tsv"))
	t.Setenv("ROBIN_TEST_DOCKER_LIST", filepath.Join(dir, "containers.list"))
	t.Setenv("ROBIN_TEST_DOCKER_LOG_DIR", dir)
	if err := os.WriteFile(os.Getenv("ROBIN_TEST_DOCKER_INFO"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func writeDockerFixture(t *testing.T, dir, id, name, driver, logPath string, created time.Time, logText string, options ...string) {
	t.Helper()
	info, err := os.OpenFile(os.Getenv("ROBIN_TEST_DOCKER_INFO"), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	logOptions := "{}"
	if len(options) > 0 {
		logOptions = options[0]
	}
	_, writeErr := fmt.Fprintf(info, "%s\t/%s\t%s\t%s\t%s\t%s\n", id, name, logPath, driver, created.Format(time.RFC3339Nano), logOptions)
	closeErr := info.Close()
	if writeErr != nil || closeErr != nil {
		t.Fatalf("write fake Docker metadata: %v / %v", writeErr, closeErr)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".log"), []byte(logText), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeDockerList(t *testing.T, dir string, ids ...string) {
	t.Helper()
	var lines []string
	data, err := os.ReadFile(os.Getenv("ROBIN_TEST_DOCKER_INFO"))
	if err != nil {
		t.Fatal(err)
	}
	allowed := make(map[string]bool, len(ids))
	for _, id := range ids {
		allowed[id] = true
	}
	for _, row := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		fields := strings.Split(row, "\t")
		if len(fields) == 6 && allowed[fields[0]] {
			lines = append(lines, fields[0]+"\t"+strings.TrimPrefix(fields[1], "/"))
		}
	}
	if err := os.WriteFile(os.Getenv("ROBIN_TEST_DOCKER_LIST"), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func appendDockerLog(t *testing.T, dir, id, line string) {
	t.Helper()
	file, err := os.OpenFile(filepath.Join(dir, id+".log"), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.WriteString(line); err != nil {
		t.Fatal(err)
	}
}
