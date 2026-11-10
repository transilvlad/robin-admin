package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPreviewReadsRequestedTailAndFlushesFinalEntry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rspamd.log")
	var content strings.Builder
	for i := 0; i < 300; i++ {
		fmt.Fprintf(&content, "INFO entry-%03d\n", i)
	}

	fmt.Fprintf(&content, "%s INFO final password=preview-secret\n", time.Now().UTC().Format(time.RFC3339))
	appendFile(t, path, content.String())
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	lines, counters, err := previewLogEntries(context.Background(), ownedService{ServiceID: "preview", ServiceType: "rspamd"}, 24*time.Hour, 250)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 250 || !strings.Contains(lines[0], "entry-051") ||
		!strings.Contains(lines[len(lines)-1], "final password=[REDACTED]") ||
		strings.Contains(strings.Join(lines, "\n"), "preview-secret") || counters.Read != 301 {
		t.Fatalf("preview missed the requested tail or final entry: %d lines, %+v", len(lines), counters)
	}
}

func TestPreviewReportsCurrentRateLimiting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rspamd.log")
	appendFile(t, path, strings.Repeat("INFO preview\n", 5))
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_RATE_PER_SECOND", "1")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_RATE_BURST", "1")
	_, counters, err := previewLogEntries(context.Background(), ownedService{ServiceID: "preview", ServiceType: "rspamd"}, time.Hour, 10)
	if err != nil {
		t.Fatal(err)
	}
	if counters.RateLimited != 4 || counters.RateLimitedCurrent != 4 {
		t.Fatalf("preview did not report current rate limiting: %+v", counters)
	}
}
