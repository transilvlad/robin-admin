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
				File: &logCursor{Key: "docker-json-file:long-id", Path: path, Source: path},
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
		fmt.Sprintf("%s selected-tail\n", base.Add(4*time.Second).Format(time.RFC3339Nano)))
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
	if err != nil || !changed.Reset || len(changed.Lines) != 1 || !strings.Contains(changed.Lines[0], "selected-tail") {
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
	if first.Lines[0] != "[postal-smtp-1] smtp" || first.Lines[1] != "[postal-worker-1] worker1" {
		t.Fatalf("containers were not time-ordered and tagged: %q", first.Lines)
	}

	newAt := base.Add(time.Second)
	writeDockerFixture(t, dir, "worker2", "postal-worker-2", "local", "", base,
		fmt.Sprintf("%s worker2\n", newAt.Format(time.RFC3339Nano)))
	writeDockerList(t, dir, "smtp", "worker1", "worker2")
	next, _, err := followContainerSet(context.Background(), "docker:postal-*", "postal-*", "", &first.Next)
	if err != nil || next.Reset || !strings.Contains(strings.Join(next.Lines, "\n"), "[postal-worker-2] worker2") {
		t.Fatalf("new worker was not picked up without config changes: %+v, %v", next, err)
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
		fmt.Sprintf("%s after-recreate\n", created.Add(time.Second).Format(time.RFC3339Nano)))
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
	if err := os.WriteFile(logPath, []byte(fmt.Sprintf("{\"log\":\"first\\n\",\"time\":%q,\"stream\":\"stdout\"}\n", base.Format(time.RFC3339Nano))), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDockerFixture(t, dir, "json-id", "postal-json-1", "json-file", logPath, base, "")
	writeDockerList(t, dir, "json-id")
	first, _, err := followContainerSet(context.Background(), "docker:postal-json-*", "postal-json-*", "", nil)
	if err != nil || len(first.Lines) != 1 || first.Lines[0] != "[postal-json-1] first" {
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

func setupFakeDocker(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	script := `#!/bin/sh
case "$1" in
  ps) cat "$ROBIN_TEST_DOCKER_LIST" ;;
  inspect) id="$4"; awk -F '\t' -v id="$id" '$1 == id { print; found=1 } END { if (!found) exit 1 }' "$ROBIN_TEST_DOCKER_INFO" ;;
  logs) for arg in "$@"; do id="$arg"; done; cat "$ROBIN_TEST_DOCKER_LOG_DIR/$id.log" ;;
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

func writeDockerFixture(t *testing.T, dir, id, name, driver, logPath string, created time.Time, logText string) {
	t.Helper()
	info, err := os.OpenFile(os.Getenv("ROBIN_TEST_DOCKER_INFO"), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, writeErr := fmt.Fprintf(info, "%s\t/%s\t%s\t%s\t%s\n", id, name, logPath, driver, created.Format(time.RFC3339Nano))
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
		if len(fields) == 5 && allowed[fields[0]] {
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
