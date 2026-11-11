package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func freshLogStates(t *testing.T) {
	t.Helper()
	logStates = &logStateStore{}
	t.Cleanup(func() { logStates = &logStateStore{} })
}

func appendFile(t *testing.T, path, text string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

type logPushRecorder struct {
	bodies []map[string]any
	status func(n int) int
}

func (r *logPushRecorder) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		r.bodies = append(r.bodies, body)
		code := http.StatusOK
		if r.status != nil {
			code = r.status(len(r.bodies))
		}
		w.WriteHeader(code)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func bodyLines(body map[string]any) string {
	lines, _ := body["lines"].([]any)
	parts := make([]string, len(lines))
	for i, l := range lines {
		parts[i], _ = l.(string)
	}
	return strings.Join(parts, ",")
}

func TestExcludedBacklogContinuesWithinCycle(t *testing.T) {
	freshLogStates(t)
	path := filepath.Join(t.TempDir(), "rspamd.log")
	appendFile(t, path, "initial\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_EXCLUDE", "drop-me")
	rec := &logPushRecorder{}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "backlog", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	st, err := logStates.service("", svc.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	before := st.Counters.Read
	appendFile(t, path, strings.Repeat("drop-me\n", 12000))
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	if got := st.Counters.Read - before; got != 12000 {
		t.Fatalf("read only %d excluded backlog lines", got)
	}
}

func TestRateLimitPrefersWarningsAcrossReadChunks(t *testing.T) {
	freshLogStates(t)
	path := filepath.Join(t.TempDir(), "rspamd.log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_RATE_PER_SECOND", "200")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_RATE_BURST", "400")
	rec := &logPushRecorder{}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "priority", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	appendFile(t, path, strings.Repeat("DEBUG early\n", 5000)+strings.Repeat("WARN later\n", 400))
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	var output string
	for _, body := range rec.bodies[1:] {
		output += bodyLines(body)
	}
	debugKept := strings.Count(output, "DEBUG early")
	if strings.Count(output, "WARN later") != 400 || debugKept >= 5000 ||
		!strings.Contains(output, fmt.Sprintf("%d lines dropped by rate limit", 5000-debugKept)) {
		t.Fatalf("bounded read window did not prioritize warnings: %q", output)
	}
}

func TestRateLimitWaitsForHeldEntryBeforeSelectingWindow(t *testing.T) {
	for _, excluded := range []bool{false, true} {
		t.Run(fmt.Sprintf("excluded=%t", excluded), func(t *testing.T) {
			freshLogStates(t)
			dir := t.TempDir()
			path := filepath.Join(dir, "rspamd.log")
			if err := os.WriteFile(path, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
			t.Setenv("ROBIN_AGENT_RSPAMD_LOG_ENTRY_STARTS_WITH", "^START")
			t.Setenv("ROBIN_AGENT_RSPAMD_LOG_RATE_PER_SECOND", "0.001")
			t.Setenv("ROBIN_AGENT_RSPAMD_LOG_RATE_BURST", "1")
			if excluded {
				t.Setenv("ROBIN_AGENT_RSPAMD_LOG_EXCLUDE", "discard continuation")
			}
			rec := &logPushRecorder{}
			srv := rec.server(t)
			svc := ownedService{ServiceID: "held-priority", ServiceType: "rspamd"}
			c := config{adminURL: srv.URL, statePath: filepath.Join(dir, "agent.json")}
			pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
			appendFile(t, path, "START DEBUG low\nSTART ERROR high\n")
			pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
			for _, body := range rec.bodies {
				if strings.Contains(bodyLines(body), "DEBUG low") {
					t.Fatal("lower-severity entry was shipped before the held entry could be filtered")
				}
			}

			// Restart while the complete candidate and open entry are pending.
			logStates = &logStateStore{}
			if excluded {
				appendFile(t, path, "  discard continuation\n")
			}
			appendFile(t, path, "START INFO next\n")
			pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
			var output string
			for _, body := range rec.bodies {
				output += bodyLines(body) + "\n"
			}
			if excluded {
				if !strings.Contains(output, "DEBUG low") || strings.Contains(output, "ERROR high") ||
					strings.Contains(output, "dropped by rate limit") {
					t.Fatalf("excluded held entry displaced a valid lower-severity entry: %q", output)
				}
			} else if strings.Contains(output, "DEBUG low") || !strings.Contains(output, "ERROR high") ||
				!strings.Contains(output, "1 lines dropped by rate limit") {
				t.Fatalf("held error did not displace the lower-severity entry: %q", output)
			}
		})
	}
}

func TestHeldResetEntryIsAppendedAsHistorical(t *testing.T) {
	freshLogStates(t)
	path := filepath.Join(t.TempDir(), "rspamd.log")
	appendFile(t, path, "2026-11-10T14:15:25Z INFO historical\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	rec := &logPushRecorder{}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "reset", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL, statePath: filepath.Join(t.TempDir(), "agent.json")}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	logStates = &logStateStore{}
	appendFile(t, path, "2026-11-10T14:15:26Z INFO live\n")
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	if len(rec.bodies) != 2 || rec.bodies[1]["reset"] != true || rec.bodies[1]["resetAppend"] != true ||
		!strings.Contains(bodyLines(rec.bodies[1]), "historical") {
		t.Fatalf("held reset tail was sent as new history: %+v", rec.bodies)
	}
}

func TestReadFileChunkShipsOnlyCompleteNewLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mail.log")
	if err := os.WriteFile(path, []byte("one\r\ntwo\npart"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, offset, more, err := readFileChunk(path, 0)
	if err != nil || strings.Join(lines, ",") != "one,two" || offset != 9 || more {
		t.Fatalf("first read = %q @%d more=%v, %v", lines, offset, more, err)
	}
	appendFile(t, path, "ial\nthree\n")
	if lines, _, _, _ = readFileChunk(path, offset); strings.Join(lines, ",") != "partial,three" {
		t.Fatalf("second read = %q", lines)
	}
	// A file that shrank below the offset is read from its start.
	_ = os.WriteFile(path, []byte("new\n"), 0o644)
	if lines, _, _, _ = readFileChunk(path, offset); strings.Join(lines, ",") != "new" {
		t.Fatalf("after truncation = %q", lines)
	}
}

func TestIncompleteInitialTailIsDiscardedAcrossRestartAndRotation(t *testing.T) {
	for _, rotate := range []bool{false, true} {
		t.Run(fmt.Sprintf("rotate=%t", rotate), func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "mail.log")
			appendFile(t, path, "password=review-secret-prefix")
			first, _, err := followFileWithTail("file:test", path, "", nil, 4, 10, 10, 16)
			if err != nil || !first.Next.SkipPartial || first.InputDropped != 1 {
				t.Fatalf("initial incomplete tail was not marked for discard: %+v, %v", first, err)
			}
			store := &logStateStore{}
			statePath := filepath.Join(dir, "agent.json")
			st, err := store.service(statePath, "mail")
			if err != nil {
				t.Fatal(err)
			}
			st.Cursor = &first.Next
			if err := store.save(); err != nil {
				t.Fatal(err)
			}
			if rotate {
				if err := os.Rename(path, path+".1"); err != nil {
					t.Fatal(err)
				}
				appendFile(t, path, "uncertain-suffix\nsafe\n")
			} else {
				appendFile(t, path, "-suffix\nsafe\n")
			}
			st, err = (&logStateStore{}).service(statePath, "mail")
			if err != nil {
				t.Fatal(err)
			}
			cursor := st.Cursor
			var lines []string
			for i := 0; i < 30; i++ {
				batch, more, err := followFileWithTail("file:test", path, "", cursor, 4, 10, 10, 16)
				if err != nil {
					t.Fatal(err)
				}
				lines = append(lines, batch.Lines...)
				cursor = &batch.Next
				if !more {
					break
				}
			}
			if cursor.SkipPartial || strings.Join(lines, ",") != "safe" {
				t.Fatalf("initial fragment escaped or following line was lost: %q cursor=%+v", lines, cursor)
			}
		})
	}
}

func TestFileRotationDiscardsIncompleteLineAndPossibleContinuation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mail.log")
	appendFile(t, path, "initial\n")
	initial, _, err := followFile("file:test", path, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, "password=private-")
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, "secret\nsafe\n")
	rotated, more, err := followFile("file:test", path, "", &initial.Next)
	if err != nil || !more || rotated.InputDropped != 1 || !rotated.Next.SkipPartial {
		t.Fatalf("incomplete line was not marked for discard across rotation: %+v, more=%t, %v", rotated, more, err)
	}
	resumed, _, err := followFile("file:test", path, "", &rotated.Next)
	if err != nil || resumed.InputDropped != 0 || resumed.Next.SkipPartial ||
		strings.Join(resumed.Lines, ",") != "safe" {
		t.Fatalf("rotated line suffix escaped or the following line was lost: %+v, %v", resumed, err)
	}
}

func TestMissingFileDiscardsPossibleLineContinuation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mail.log")
	appendFile(t, path, "initial\n")
	initial, _, err := followFile("file:test", path, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, "secret\nsafe\n")
	resumed, _, err := followFile("file:test", path, "", &initial.Next)
	if err != nil || resumed.InputDropped != 1 || resumed.Next.SkipPartial ||
		strings.Join(resumed.Lines, ",") != "safe" {
		t.Fatalf("missing file exposed an uncertain line boundary: %+v, %v", resumed, err)
	}
}

func TestInitialTailDistinguishesCompleteAndPartialBoundaries(t *testing.T) {
	tests := []struct {
		name        string
		content     string
		tailBytes   int
		wantLines   string
		wantDropped uint64
	}{
		{"complete", "prefix\nkeep\nmore\n", len("keep\nmore\n"), "keep,more", 0},
		{"partial", "prefix-secret\nkeep\n", len("secret\nkeep\n"), "keep", 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "mail.log")
			if err := os.WriteFile(path, []byte(tt.content), 0o600); err != nil {
				t.Fatal(err)
			}
			batch, _, err := followFileWithTail("file:test", path, "", nil, 100, 10, 10, tt.tailBytes)
			if err != nil || strings.Join(batch.Lines, ",") != tt.wantLines || batch.InputDropped != tt.wantDropped {
				t.Fatalf("incorrect initial boundary: %+v, %v", batch, err)
			}
		})
	}
}

func TestFollowFileDiscardsOversizedIncompleteLineIncrementally(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mail.log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	initial, _, err := followFile("file:test", path, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, strings.Repeat("x", logRawEntryMaxBytes+2*logBatchMaxBytes))
	batch, more, err := followFile("file:test", path, "", &initial.Next)
	if err != nil || len(batch.Lines) != 0 || batch.InputDropped != 1 ||
		!batch.Next.SkipPartial || batch.Next.Offset == 0 || !more {
		t.Fatalf("oversized unfinished line was not bounded and discarded: %+v more=%t, %v", batch, more, err)
	}
	statePath := filepath.Join(dir, "agent.json")
	store := &logStateStore{}
	st, err := store.service(statePath, "mail")
	if err != nil {
		t.Fatal(err)
	}
	st.Cursor = &batch.Next
	if err := store.save(); err != nil {
		t.Fatal(err)
	}
	st, err = (&logStateStore{}).service(statePath, "mail")
	if err != nil {
		t.Fatal(err)
	}
	cursor := st.Cursor
	for more {
		batch, more, err = followFile("file:test", path, "", cursor)
		if err != nil || len(batch.Lines) != 0 || batch.InputDropped != 0 {
			t.Fatalf("discarded line was counted again or leaked: %+v, %v", batch, err)
		}
		cursor = &batch.Next
	}
	if !cursor.SkipPartial {
		t.Fatal("discard must continue until the terminating newline")
	}
	appendFile(t, path, "private-suffix\nsafe\n")
	batch, _, err = followFile("file:test", path, "", cursor)
	if err != nil || batch.Next.SkipPartial || strings.Join(batch.Lines, ",") != "safe" || batch.InputDropped != 0 {
		t.Fatalf("line suffix escaped or next complete line was lost: %+v, %v", batch, err)
	}
}

func TestReadFileChunkReadsABacklogInBatches(t *testing.T) {
	path := filepath.Join(t.TempDir(), "big.log")
	line := strings.Repeat("x", 99) + "\n"
	if err := os.WriteFile(path, []byte(strings.Repeat(line, 25000)), 0o644); err != nil {
		t.Fatal(err)
	}
	var offset int64
	total, reads := 0, 0
	for more := true; more; reads++ {
		var lines []string
		var err error
		lines, offset, more, err = readFileChunk(path, offset)
		if err != nil {
			t.Fatal(err)
		}
		total += len(lines)
	}
	if total != 25000 || reads != 5 {
		t.Fatalf("read %d lines in %d batches", total, reads)
	}
}

func TestReadFileChunkDoesNotSkipLargeBacklogs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backlog.log")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	line := strings.Repeat("x", 4095) + "\n"
	const totalLines = 16_385
	chunk := strings.Repeat(line, 64)
	for i := 0; i < totalLines/64; i++ {
		if _, err := f.WriteString(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.WriteString(line); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	var offset int64
	total := 0
	for more := true; more; {
		var lines []string
		lines, offset, more, err = readFileChunk(path, offset)
		if err != nil {
			t.Fatal(err)
		}
		if len(lines) > logBatchMaxLines {
			t.Fatalf("batch exceeded %d lines", logBatchMaxLines)
		}
		total += len(lines)
	}
	if total != totalLines || offset != int64(totalLines*len(line)) {
		t.Fatalf("read %d of %d lines, stopped at %d", total, totalLines, offset)
	}
}

func TestReadFileChunkKeepsLongLinesWholeAndWaitsForNewline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "long.log")
	longLine := strings.Repeat("x", logBatchMaxBytes+100)
	if err := os.WriteFile(path, []byte(longLine), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, offset, more, err := readFileChunk(path, 0)
	if err != nil || len(lines) != 0 || offset != 0 || more {
		t.Fatalf("unfinished long line advanced: %d lines @%d more=%v, %v", len(lines), offset, more, err)
	}
	appendFile(t, path, "\nnext\n")
	lines, offset, more, err = readFileChunk(path, 0)
	if err != nil || len(lines) != 1 || len(lines[0]) != len(longLine) || offset != int64(len(longLine)+1) || !more {
		t.Fatalf("long line = %d lines @%d more=%v, %v", len(lines), offset, more, err)
	}
	lines, _, more, err = readFileChunk(path, offset)
	if err != nil || strings.Join(lines, ",") != "next" || more {
		t.Fatalf("after long line = %q more=%v, %v", lines, more, err)
	}
}

func TestFollowFileFinishesARotatedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mail.log")
	appendFile(t, path, "2026-11-04T10:00:00Z first\n")
	tail, _, err := followFile("key", path, "", nil)
	if err != nil || !tail.Reset || strings.Join(tail.Lines, ",") != "2026-11-04T10:00:00Z first" {
		t.Fatalf("tail = %+v, %v", tail, err)
	}
	appendFile(t, path, "written before rotation\n")
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, "after rotation\n")

	rest, more, err := followFile("key", path, "", &tail.Next)
	if err != nil || strings.Join(rest.Lines, ",") != "written before rotation" || !more || rest.Next.Path != path || rest.Next.Offset != 0 {
		t.Fatalf("rotated remainder = %+v more=%v, %v", rest, more, err)
	}
	fresh, more, err := followFile("key", path, "", &rest.Next)
	if err != nil || strings.Join(fresh.Lines, ",") != "after rotation" || more {
		t.Fatalf("new file = %+v more=%v, %v", fresh, more, err)
	}
}

func TestFollowFileReadsMultipleRotationsWithIdenticalPrefixes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("identical-prefix rotation detection relies on Unix inode identity")
	}
	path := filepath.Join(t.TempDir(), "mail.log")
	appendFile(t, path, "shared prefix\n")
	tail, _, err := followFile("key", path, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, "old remainder\n")
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, "shared prefix\nmiddle\n")
	if err := os.Rename(path+".1", path+".2"); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, "shared prefix\nnew\n")
	cur := tail.Next
	var lines []string
	for more := true; more; {
		var batch *logBatch
		batch, more, err = followFile("key", path, "", &cur)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, batch.Lines...)
		cur = batch.Next
	}
	if got := strings.Join(lines, ","); got != "old remainder,shared prefix,middle,shared prefix,new" {
		t.Fatalf("rotation sequence = %q", got)
	}
}

func TestFollowDatedFilesReadsEveryRemainingFile(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "2026-11-01.log")
	appendFile(t, first, "first\n")
	list := func() ([]string, error) { return datedLogFiles(dir, "*.log") }
	candidates, err := snapshotLogCandidates(list)
	if err != nil {
		t.Fatal(err)
	}
	tail, _, err := followFileCandidates("key", first, "", nil, candidates, openLogCandidate)
	if err != nil {
		t.Fatal(err)
	}
	appendFile(t, first, "old remainder\n")
	second := filepath.Join(dir, "2026-11-02.log")
	third := filepath.Join(dir, "2026-11-03.log")
	appendFile(t, second, "middle\n")
	appendFile(t, third, "new\n")
	base := time.Now().Add(-time.Hour)
	for i, path := range []string{first, second, third} {
		stamp := base.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	candidates, err = snapshotLogCandidates(list)
	if err != nil {
		t.Fatal(err)
	}
	cur := tail.Next
	var lines []string
	for more := true; more; {
		var batch *logBatch
		batch, more, err = followFileCandidates("key", third, "", &cur, candidates, openLogCandidate)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, batch.Lines...)
		cur = batch.Next
	}
	if got := strings.Join(lines, ","); got != "old remainder,middle,new" {
		t.Fatalf("dated rotation sequence = %q", got)
	}
}

func TestFollowFileRetriesWhenSuccessorRotatesDuringRead(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("renaming an open log file is not supported on Windows")
	}
	path := filepath.Join(t.TempDir(), "mail.log")
	appendFile(t, path, "old\n")
	tail, _, err := followFile("key", path, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, "old remainder\n")
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, "middle\n")
	candidates, err := snapshotLogCandidates(func() ([]string, error) { return numberedLogFiles(path) })
	if err != nil {
		t.Fatal(err)
	}
	rotated := false
	open := func(candidate logFileCandidate) (*os.File, error) {
		if candidate.path == path && !rotated {
			rotated = true
			if err := os.Rename(path+".1", path+".2"); err != nil {
				return nil, err
			}
			if err := os.Rename(path, path+".1"); err != nil {
				return nil, err
			}
			appendFile(t, path, "newest\n")
		}
		return openLogCandidate(candidate)
	}
	batch, _, err := followFileCandidates("key", path, "", &tail.Next, candidates, open)
	if !rotated || err == nil || batch != nil {
		t.Fatalf("changed successor must be retried, got batch=%+v rotated=%v err=%v", batch, rotated, err)
	}
	cur := tail.Next
	var lines []string
	for more := true; more; {
		batch, more, err = followFile("key", path, "", &cur)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, batch.Lines...)
		cur = batch.Next
	}
	if got := strings.Join(lines, ","); got != "old remainder,middle,newest" {
		t.Fatalf("rotation sequence after retry = %q", got)
	}
}

func TestFollowFileReplaysAvailableFilesWhenFingerprintIsAmbiguous(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mail.log")
	appendFile(t, path, "shared prefix\n")
	tail, _, err := followFile("key", path, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Keep the old inode allocated while removing it from the candidate set.
	if err := os.Link(path, path+".archive"); err != nil {
		t.Skipf("hard links are unavailable: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	appendFile(t, path+".1", "shared prefix\nmiddle\n")
	appendFile(t, path, "shared prefix\nnew\n")
	cur := tail.Next
	var lines []string
	var dropped uint64
	for more := true; more; {
		var batch *logBatch
		batch, more, err = followFile("key", path, "", &cur)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, batch.Lines...)
		dropped += batch.InputDropped
		cur = batch.Next
	}
	if got := strings.Join(lines, ","); got != "middle,shared prefix,new" || dropped != 1 {
		t.Fatalf("ambiguous replay did not discard its uncertain boundary: %q, dropped=%d", got, dropped)
	}
}

func TestFollowFileRestartsAReplacedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mail.log")
	appendFile(t, path, "old line one\nold line two\n")
	tail, _, _ := followFile("key", path, "", nil)
	_ = os.WriteFile(path, []byte("uncertain boundary\nnew content that is longer than before\n"), 0o644)
	batch, _, err := followFile("key", path, "", &tail.Next)
	if err != nil || batch.InputDropped != 1 || strings.Join(batch.Lines, ",") != "new content that is longer than before" {
		t.Fatalf("replaced file = %+v, %v", batch, err)
	}
}

func TestPushServiceLogsSendsEmptyBatchAsArray(t *testing.T) {
	freshLogStates(t)
	path := filepath.Join(t.TempDir(), "rspamd.log")
	appendFile(t, path, "first\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	rec := &logPushRecorder{}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "svc-empty-batch", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL}
	pushServiceLogs(context.Background(), srv.Client(), c, state{AgentID: "a", Credential: "c"}, svc) // reset tail
	pushServiceLogs(context.Background(), srv.Client(), c, state{AgentID: "a", Credential: "c"}, svc) // quiet cycle

	if len(rec.bodies) != 2 || rec.bodies[0]["reset"] != true || rec.bodies[1]["reset"] != false {
		t.Fatalf("unexpected pushes: %v", rec.bodies)
	}
	if lines, ok := rec.bodies[1]["lines"].([]any); !ok || len(lines) != 0 {
		t.Fatalf("quiet cycle must send lines: [], got %#v", rec.bodies[1]["lines"])
	}
	if _, ok := rec.bodies[1]["batchId"]; ok {
		t.Fatal("an empty batch has nothing to deduplicate")
	}
	st, err := logStates.service("", svc.ServiceID)
	if err != nil || st.Cursor == nil {
		t.Fatal("a successful quiet push must keep the position")
	}
}

func TestFailedLogHeartbeatIsReportedAndDoesNotAdvance(t *testing.T) {
	freshLogStates(t)
	path := filepath.Join(t.TempDir(), "rspamd.log")
	appendFile(t, path, "match initial\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILTER", "match")
	rec := &logPushRecorder{status: func(n int) int {
		if n == 2 {
			return http.StatusServiceUnavailable
		}
		return http.StatusOK
	}}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "svc-heartbeat", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	st, err := logStates.service("", svc.ServiceID)
	if err != nil {
		t.Fatal(err)
	}
	offset := st.Cursor.Offset
	appendFile(t, path, "filtered line\n")
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	if st.Cursor.Offset != offset || !strings.Contains(output.String(), "refused a log heartbeat") {
		t.Fatalf("failed heartbeat advanced the cursor or was not reported: offset=%d logs=%q", st.Cursor.Offset, output.String())
	}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	if st.Cursor.Offset <= offset {
		t.Fatal("successful heartbeat did not advance past filtered lines")
	}
}

func TestLogPositionSurvivesARestart(t *testing.T) {
	freshLogStates(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "rspamd.log")
	appendFile(t, path, "before start\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	rec := &logPushRecorder{}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "svc-restart", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL, statePath: filepath.Join(dir, "state.json")}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)

	appendFile(t, path, "2026-11-04 10:00:00 #1(main) written while stopped\ncontinuation\n")
	logStates = &logStateStore{} // a restarted agent reloads its positions from disk
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	time.Sleep(2100 * time.Millisecond)
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)

	if len(rec.bodies) != 3 || rec.bodies[2]["reset"] != false {
		t.Fatalf("a restart with a saved position must not reset: %v", rec.bodies)
	}
	if got := bodyLines(rec.bodies[2]); got != "2026-11-04 10:00:00 #1(main) written while stopped\ncontinuation" {
		t.Fatalf("lines after restart = %q", got)
	}
	times, _ := rec.bodies[2]["times"].([]any)
	if len(times) != 1 || times[0] == "" {
		t.Fatalf("a multiline entry keeps the first line's time: %v", times)
	}
	if id, _ := rec.bodies[2]["batchId"].(string); len(id) != 32 {
		t.Fatalf("a batch with lines carries an id: %v", rec.bodies[2]["batchId"])
	}
}

func TestUnacknowledgedLogBatchIsResent(t *testing.T) {
	freshLogStates(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "rspamd.log")
	appendFile(t, path, "start\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	rec := &logPushRecorder{status: func(n int) int {
		if n == 2 {
			return http.StatusServiceUnavailable
		}
		return http.StatusOK
	}}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "svc-retry", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL, statePath: filepath.Join(dir, "state.json")}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc) // reset tail
	appendFile(t, path, "first\n")
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc) // refused
	appendFile(t, path, "second\n")
	logStates = &logStateStore{}                                         // the pending batch also survives a restart
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc) // resent, then the next batch

	if len(rec.bodies) != 4 {
		t.Fatalf("pushes = %d: %v", len(rec.bodies), rec.bodies)
	}
	failed, resent, next := rec.bodies[1], rec.bodies[2], rec.bodies[3]
	if bodyLines(failed) != "first" || bodyLines(resent) != "first" || failed["batchId"] != resent["batchId"] {
		t.Fatalf("the refused batch must be resent unchanged: %v / %v", failed, resent)
	}
	if bodyLines(next) != "second" || next["batchId"] == resent["batchId"] {
		t.Fatalf("reading continues after the acknowledgement: %v", next)
	}
}

func TestLegacyPendingBatchesAreRedactedDurablyBeforeRetry(t *testing.T) {
	freshLogStates(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "rspamd.log")
	appendFile(t, path, "already read\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	position := map[string]any{
		"key": "file:" + path + "|", "source": path, "path": path, "offset": len("already read\n"),
	}
	old := map[string]any{"legacy": map[string]any{
		"cursor": map[string]any{"key": "file:" + path + "|", "source": path, "path": path},
		"pending": map[string]any{
			"id": "legacy-first", "source": path, "lines": []string{"password=review-secret"},
			"times": []string{""}, "next": position,
		},
		"pendingQueue": []any{map[string]any{
			"id": "legacy-second", "source": path, "lines": []string{"other-sensitive-value"},
			"times": []string{""}, "next": position,
		}},
	}}
	data, err := json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(dir, "state.json")
	if err := os.WriteFile(logStatePath(statePath), data, 0o600); err != nil {
		t.Fatal(err)
	}
	rec := &logPushRecorder{status: func(n int) int {
		if n == 1 || n == 3 {
			return http.StatusServiceUnavailable
		}
		return http.StatusOK
	}}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "legacy", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL, statePath: statePath}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	persisted, err := os.ReadFile(logStatePath(statePath))
	if err != nil || strings.Contains(string(persisted), "review-secret") || strings.Contains(string(persisted), "other-sensitive-value") {
		t.Fatalf("legacy queue was not sanitized on disk before retry: %s, %v", persisted, err)
	}
	logStates = &logStateStore{}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	st, err := logStates.service(statePath, svc.ServiceID)
	if err != nil || st.Cursor.Offset != 0 || st.Pending == nil || st.Pending.ID != "legacy-second" {
		t.Fatalf("cursor advanced before the legacy queue was acknowledged: %+v, %v", st, err)
	}
	logStates = &logStateStore{}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	if len(rec.bodies) < 4 {
		t.Fatalf("legacy queue was not retried: %+v", rec.bodies)
	}
	for i, id := range []string{"legacy-first", "legacy-first", "legacy-second", "legacy-second"} {
		if rec.bodies[i]["batchId"] != id || bodyLines(rec.bodies[i]) != "[REDACTED] legacy pending log line" {
			t.Fatalf("legacy retry changed id or exposed content: %+v", rec.bodies)
		}
	}
	st, err = logStates.service(statePath, svc.ServiceID)
	if err != nil || st.Pending != nil || st.Cursor.Offset != int64(len("already read\n")) {
		t.Fatalf("acknowledged legacy queue did not advance: %+v, %v", st, err)
	}
}

func TestOversizedLogBatchIsSplitDurablyBeforeCursorAdvances(t *testing.T) {
	freshLogStates(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "rspamd.log")
	statePath := filepath.Join(dir, "state.json")
	appendFile(t, path, "initial\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	var cursorAtSplit int64
	rec := &logPushRecorder{status: func(n int) int {
		switch n {
		case 2:
			return http.StatusRequestEntityTooLarge
		case 3:
			return http.StatusServiceUnavailable
		case 5:
			st, err := logStates.service(statePath, "svc-split")
			if err != nil {
				t.Errorf("load split state before final fragment acknowledgement: %v", err)
			} else if st.Cursor == nil || st.Cursor.Offset != cursorAtSplit || st.Pending == nil || len(st.PendingQueue) != 0 {
				t.Errorf("cursor or fragment queue advanced before final acknowledgement: %+v", st)
			}
		}
		return http.StatusOK
	}}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "svc-split", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL, statePath: statePath}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	start, err := logStates.service(c.statePath, svc.ServiceID)
	if err != nil || start.Cursor == nil {
		t.Fatalf("initial cursor was not saved: %+v, %v", start, err)
	}
	cursorAtSplit = start.Cursor.Offset
	appendFile(t, path, "one\ntwo\nthree\nfour\n")
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	pending, err := logStates.service(c.statePath, svc.ServiceID)
	if err != nil || pending.Pending == nil || len(pending.PendingQueue) != 1 || pending.Cursor.Offset != cursorAtSplit {
		t.Fatalf("split fragments were not durably retained: %+v, %v", pending, err)
	}
	logStates = &logStateStore{}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)

	if len(rec.bodies) < 5 {
		t.Fatalf("expected original, retry, and two fragments: %v", rec.bodies)
	}
	original, first, remainder := rec.bodies[1], rec.bodies[3], rec.bodies[4]
	if bodyLines(original) != "one,two,three,four" || bodyLines(first) != "one,two" || bodyLines(remainder) != "three,four" {
		t.Fatalf("unexpected fragment contents: %v", rec.bodies)
	}
	if original["batchId"] == first["batchId"] || first["batchId"] == remainder["batchId"] || original["batchId"] == remainder["batchId"] {
		t.Fatalf("each fragment must use a unique id: %v", rec.bodies)
	}
	final, err := logStates.service(c.statePath, svc.ServiceID)
	if err != nil || final.Pending != nil || len(final.PendingQueue) != 0 || final.Cursor == nil || final.Cursor.Offset <= cursorAtSplit {
		t.Fatalf("cursor did not advance after all fragments were acknowledged: %+v, %v", final, err)
	}
}

func TestPendingLogBatchIsNotSentWhenStateCannotBeSaved(t *testing.T) {
	freshLogStates(t)
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	if err := os.Mkdir(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "rspamd.log")
	appendFile(t, path, "start\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	rec := &logPushRecorder{}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "svc-state-write", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL, statePath: filepath.Join(stateDir, "state.json")}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	appendFile(t, path, "not yet sent\n")
	backup := stateDir + "-backup"
	if err := os.Rename(stateDir, backup); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stateDir, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	if len(rec.bodies) != 1 {
		t.Fatalf("sent a batch without persisting it: %v", rec.bodies)
	}
	if err := os.Remove(stateDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(backup, stateDir); err != nil {
		t.Fatal(err)
	}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	if len(rec.bodies) != 2 || bodyLines(rec.bodies[1]) != "not yet sent" {
		t.Fatalf("did not resume after state became writable: %v", rec.bodies)
	}
}

func TestAcknowledgedBatchKeepsItsIDWhenCursorSaveFails(t *testing.T) {
	freshLogStates(t)
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	if err := os.Mkdir(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "rspamd.log")
	appendFile(t, path, "start\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	backup := stateDir + "-backup"
	var sabotageErr error
	rec := &logPushRecorder{status: func(n int) int {
		if n == 2 {
			sabotageErr = os.Rename(stateDir, backup)
			if sabotageErr == nil {
				sabotageErr = os.WriteFile(stateDir, []byte("not a directory"), 0o600)
			}
		}
		return http.StatusOK
	}}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "svc-state-ack", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL, statePath: filepath.Join(stateDir, "state.json")}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	appendFile(t, path, "accepted\n")
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	if sabotageErr != nil {
		t.Fatal(sabotageErr)
	}
	if len(rec.bodies) != 2 || rec.bodies[1]["batchId"] == nil {
		t.Fatalf("missing accepted batch: %v", rec.bodies)
	}
	if err := os.Remove(stateDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(backup, stateDir); err != nil {
		t.Fatal(err)
	}
	logStates = &logStateStore{}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	if len(rec.bodies) < 3 || rec.bodies[1]["batchId"] != rec.bodies[2]["batchId"] || bodyLines(rec.bodies[2]) != "accepted" {
		t.Fatalf("cursor save failure did not preserve the batch id: %v", rec.bodies)
	}
}

func TestCorruptLogStateDoesNotResetOrSend(t *testing.T) {
	freshLogStates(t)
	root := t.TempDir()
	path := filepath.Join(root, "rspamd.log")
	appendFile(t, path, "unread\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	c := config{statePath: filepath.Join(root, "state.json")}
	corrupt := []byte("{broken")
	if err := os.WriteFile(logStatePath(c.statePath), corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	rec := &logPushRecorder{}
	srv := rec.server(t)
	c.adminURL = srv.URL
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, ownedService{ServiceID: "svc-corrupt", ServiceType: "rspamd"})
	data, err := os.ReadFile(logStatePath(c.statePath))
	if err != nil || string(data) != string(corrupt) || len(rec.bodies) != 0 {
		t.Fatalf("corrupt state was overwritten or sent: %q, %v, %v", data, rec.bodies, err)
	}
}

func TestStructurallyCorruptLogStateIsRejected(t *testing.T) {
	for _, contents := range []string{
		`null`,
		`{"svc":null}`,
		`{"svc":{"cursor":{"key":"file:test","offset":-1}}}`,
		`{"svc":{"cursor":{"key":"file:test","fingerprintSize":4,"fingerprint":"bad"}}}`,
		`{"svc":{"cursor":{"key":"file:test","fingerprintSize":4,"fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","containers":{"container":{"seen":-1}}}}}`,
		`{"svc":{"pending":{"next":{"key":"file:test"}}}}`,
	} {
		t.Run(contents, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "positions.json")
			if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			store := &logStateStore{}
			if err := store.load(path); err == nil {
				t.Fatal("structurally corrupt state was accepted")
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != contents {
				t.Fatalf("corrupt state was overwritten: %q, %v", data, err)
			}
		})
	}
}

func TestRefusedLogBatchIsRetried(t *testing.T) {
	freshLogStates(t)
	path := filepath.Join(t.TempDir(), "rspamd.log")
	appendFile(t, path, "start\n")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	rec := &logPushRecorder{status: func(n int) int {
		if n == 2 {
			return http.StatusBadRequest
		}
		return http.StatusOK
	}}
	srv := rec.server(t)
	svc := ownedService{ServiceID: "svc-refused", ServiceType: "rspamd"}
	c := config{adminURL: srv.URL}
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	appendFile(t, path, "invalid\n")
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	appendFile(t, path, "valid\n")
	pushServiceLogs(context.Background(), srv.Client(), c, state{}, svc)
	if len(rec.bodies) != 4 || bodyLines(rec.bodies[2]) != "invalid" || rec.bodies[1]["batchId"] != rec.bodies[2]["batchId"] || bodyLines(rec.bodies[3]) != "valid" {
		t.Fatalf("a refused batch must be retried before later lines: %v", rec.bodies)
	}
}

func TestRetainForgetsServicesWithoutLogs(t *testing.T) {
	freshLogStates(t)
	statePath := filepath.Join(t.TempDir(), "state.json")
	kept, err := logStates.service(statePath, "kept")
	if err != nil {
		t.Fatal(err)
	}
	kept.Cursor = &logCursor{Key: "k"}
	gone, err := logStates.service(statePath, "gone")
	if err != nil {
		t.Fatal(err)
	}
	gone.Cursor = &logCursor{Key: "g"}
	if err := logStates.retain(statePath, map[string]bool{"kept": true}); err != nil {
		t.Fatal(err)
	}
	logStates = &logStateStore{}
	gone, err = logStates.service(statePath, "gone")
	if err != nil {
		t.Fatal(err)
	}
	kept, err = logStates.service(statePath, "kept")
	if err != nil || gone.Cursor != nil || kept.Cursor == nil {
		t.Fatal("retain must persist only the services still shipping logs")
	}
}

func TestDockerCursorKeepsEqualTimestampsAcrossBatchBoundary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Docker CLI fixture uses a shell")
	}
	dir := t.TempDir()
	tool := filepath.Join(dir, "docker")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\ncat \"$ROBIN_TEST_DOCKER_LOG\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	logPath := filepath.Join(dir, "docker.log")
	var output strings.Builder
	const stamp = "2026-11-04T10:00:00.123456789Z"
	for i := 0; i < logBatchMaxLines+1; i++ {
		fmt.Fprintf(&output, "%s line-%d\n", stamp, i)
	}
	if err := os.WriteFile(logPath, []byte(output.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ROBIN_TEST_DOCKER_LOG", logPath)
	when, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil {
		t.Fatal(err)
	}
	cur := logCursor{Key: "docker:fixture|", Since: when.Add(-time.Nanosecond), DockerCursor: 1}
	first, more, err := followContainer(context.Background(), cur.Key, "fixture", "", &cur)
	if err != nil || !more || len(first.Lines) != logBatchMaxLines || first.Next.DockerSeen != logBatchMaxLines {
		t.Fatalf("first Docker batch = %v lines more=%v, %v", len(first.Lines), more, err)
	}
	second, _, err := followContainer(context.Background(), cur.Key, "fixture", "", &first.Next)
	if err != nil || len(second.Lines) != 1 || second.Lines[0] != "line-5000" || second.Next.DockerSeen != logBatchMaxLines+1 {
		t.Fatalf("second Docker batch = %+v, %v", second, err)
	}
	last, _, err := followContainer(context.Background(), cur.Key, "fixture", "", &second.Next)
	if err != nil || len(last.Lines) != 0 {
		t.Fatalf("replayed Docker lines = %+v, %v", last, err)
	}
}

func TestParseLineTime(t *testing.T) {
	now := time.Date(2026, 1, 2, 12, 0, 0, 0, time.Local)
	local := func(y int, m time.Month, d, h, min, s int) time.Time {
		return time.Date(y, m, d, h, min, s, 0, time.Local)
	}
	cases := []struct {
		line string
		want time.Time
	}{
		{"2026-01-02T10:00:00.5Z postfix/smtpd[1]: connect", time.Date(2026, 1, 2, 10, 0, 0, 500_000_000, time.UTC)},
		{"2026-01-02T10:00:00+0100 host postfix/qmgr[2]: removed", time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC)},
		{"2026-01-02 10:00:00.123 UTC [42] LOG:  checkpoint", time.Date(2026, 1, 2, 10, 0, 0, 123_000_000, time.UTC)},
		{"2026-01-02 10:00:00,250 INFO robin", local(2026, 1, 2, 10, 0, 0).Add(250 * time.Millisecond)},
		{"[2026-01-02 10:00:00] notice", local(2026, 1, 2, 10, 0, 0)},
		{"Fri Jan  2 10:00:00 2026 -> clamd ready", local(2026, 1, 2, 10, 0, 0)},
		{"Jan  2 10:00:00 mx postfix/smtp[3]: sent", local(2026, 1, 2, 10, 0, 0)},
		{"Dec 31 23:59:59 mx postfix/smtp[3]: last year", local(2025, 12, 31, 23, 59, 59)},
	}
	for _, tc := range cases {
		got, ok := parseLineTime(tc.line, now)
		if !ok || !got.Equal(tc.want) {
			t.Errorf("parseLineTime(%q) = %v, %v; want %v", tc.line, got, ok, tc.want)
		}
	}
	if _, ok := parseLineTime("    at com.example.Main(Main.java:1)", now); ok {
		t.Error("a continuation line has no time")
	}
}

func TestJournalLineRendersShortISO(t *testing.T) {
	var entry journalEntry
	raw := `{"__CURSOR":"s=1","__REALTIME_TIMESTAMP":"1767348000000000","_HOSTNAME":"mx","SYSLOG_IDENTIFIER":"postfix/smtpd","_PID":"12","PRIORITY":"4","MESSAGE":[104,105]}`
	if err := json.Unmarshal([]byte(raw), &entry); err != nil {
		t.Fatal(err)
	}
	line, at, ok := journalLine(entry)
	if !ok || !strings.HasSuffix(line, " mx postfix/smtpd[12]: hi PRIORITY=4") || !at.Equal(time.Unix(1767348000, 0)) {
		t.Fatalf("journalLine = %q, %v, %v", line, at, ok)
	}
	if _, _, ok := journalLine(journalEntry{Realtime: "1"}); ok {
		t.Fatal("an entry without a cursor cannot be followed")
	}
}
