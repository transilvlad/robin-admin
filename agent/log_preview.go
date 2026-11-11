package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
)

func runLogPreview(args []string) error {
	flags := flag.NewFlagSet("logs preview", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	serviceID := flags.String("service", "", "owned service ID")
	serviceType := flags.String("type", "", "service type (defaults to the service ID when it matches a known type)")
	sinceText := flags.String("since", "5m", "maximum age of timestamped entries")
	limit := flags.Int("limit", 200, "maximum number of entries to print")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *serviceID == "" {
		return fmt.Errorf("--service is required")
	}
	if *limit < 1 || *limit > 10000 {
		return fmt.Errorf("--limit must be between 1 and 10000")
	}
	since, err := time.ParseDuration(*sinceText)
	if err != nil || since < 0 {
		return fmt.Errorf("--since must be a non-negative Go duration such as 5m")
	}
	kind := strings.ToLower(strings.TrimSpace(*serviceType))
	if kind == "" {
		if _, ok := logCollectors[strings.ToLower(*serviceID)]; ok {
			kind = strings.ToLower(*serviceID)
		} else {
			return fmt.Errorf("--type is required when the service ID is not a known service type")
		}
	}
	if _, ok := logCollectors[kind]; !ok {
		return fmt.Errorf("unsupported service type %q", kind)
	}
	service := ownedService{ServiceID: *serviceID, ServiceType: kind}
	lines, counters, err := previewLogEntries(context.Background(), service, since, *limit)
	if err != nil {
		return err
	}
	for _, line := range lines {
		fmt.Println(line)
	}
	output, err := json.MarshalIndent(counters, "", "  ")
	if err != nil {
		return fmt.Errorf("encode preview counters: %w", err)
	}
	fmt.Fprintf(os.Stdout, "\n--- preview counters ---\n%s\n", output)
	return nil
}

func previewLogEntries(ctx context.Context, service ownedService, since time.Duration, limit int) ([]string, logCounters, error) {
	const previewMaxBytes = 16 << 20
	rawLimit := min(100000, max(logTailLines, limit*10))
	batch, _, err := collectLogsWithTail(ctx, service, nil, rawLimit, previewMaxBytes, nil)
	if err != nil {
		return nil, logCounters{}, err
	}
	if batch == nil {
		return nil, logCounters{}, fmt.Errorf("no configured log source for service %q", service.ServiceID)
	}
	now := time.Now()
	cutoff := now.Add(-since)
	lines, times := make([]string, 0, len(batch.Lines)), make([]string, 0, len(batch.Times))
	streams := make([]string, 0, len(batch.Streams))
	for i, line := range batch.Lines {
		at := ""
		if i < len(batch.Times) {
			at = batch.Times[i]
		}
		parsed, parseErr := time.Parse(time.RFC3339Nano, at)
		if parseErr == nil && parsed.Before(cutoff) {
			continue
		}
		lines, times = append(lines, line), append(times, at)
		if i < len(batch.Streams) {
			streams = append(streams, batch.Streams[i])
		}
	}
	cfg, err := loadLogPipelineConfig(service.ServiceType, service.ServiceID)
	if err != nil {
		return nil, logCounters{}, err
	}
	entries, state, counters := processLogPipeline(lines, times, streams, false, cfg, logPipelineState{}, logCounters{}, now)
	lag := counters.ReadLagMS
	last, state, counters := processLogPipeline(nil, nil, nil, false, cfg, state, counters, now.Add(3*time.Second))
	entries = append(entries, last...)
	counters.ReadLagMS = lag
	if cfg.rate > 0 {
		previousRateLimited := counters.RateLimited
		entries, _, counters = limitLogEntries(entries, cfg, state, counters, now)
		counters.RateLimitedCurrent = counters.RateLimited - previousRateLimited
	}
	lines, _, counters = shippedLogEntries(entries, counters)
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return lines, counters, nil
}
