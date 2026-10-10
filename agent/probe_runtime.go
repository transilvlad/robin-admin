package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	probeManifestPollInterval     = 30 * time.Second
	probeObservationFlushInterval = 5 * time.Second
	probeObservationMaxAge        = 15 * time.Minute
	probeObservationMaxBytes      = 1 << 20
	probeObservationMaxCount      = 3000
	probeObservationBatchSize     = 100
)

type remoteProbeManifest struct {
	ProtocolVersion  int          `json:"protocolVersion"`
	ManifestRevision int          `json:"manifestRevision"`
	GeneratedAt      time.Time    `json:"generatedAt"`
	LocationID       int          `json:"locationId"`
	Concurrency      int          `json:"concurrency"`
	Checks           []probeCheck `json:"checks"`
}

type remoteProbeObservation struct {
	CheckID          int            `json:"checkId"`
	ManifestRevision int            `json:"manifestRevision"`
	StartedAt        time.Time      `json:"startedAt"`
	FinishedAt       time.Time      `json:"finishedAt"`
	Status           string         `json:"status"`
	ErrorCode        string         `json:"errorCode,omitempty"`
	Warning          string         `json:"warning,omitempty"`
	ResponseTimeMs   int64          `json:"responseTimeMs"`
	DNSTimeMs        int64          `json:"dnsTimeMs"`
	Details          map[string]any `json:"details"`
}

type remoteProbeResult struct {
	checkID int
	run     uint64
	// cancelled is set when probing was disabled or the agent stopped mid-run;
	// such a result says nothing about the target and is dropped.
	cancelled bool
	value     remoteProbeObservation
}

// probeRun is an in-flight check. The run number tells a late result of a
// cancelled run apart from a newer run of the same check.
type probeRun struct {
	run    uint64
	cancel context.CancelFunc
}

type probeRuntime struct {
	client  *http.Client
	config  config
	state   state
	enabled chan bool
}

func newProbeRuntime(client *http.Client, c config, s state, enabled bool) *probeRuntime {
	probeClient := *client
	probeClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	runtime := &probeRuntime{
		client:  &probeClient,
		config:  c,
		state:   s,
		enabled: make(chan bool, 1),
	}
	runtime.SetEnabled(enabled)
	return runtime
}

func (r *probeRuntime) SetEnabled(enabled bool) {
	select {
	case r.enabled <- enabled:
	default:
		<-r.enabled
		r.enabled <- enabled
	}
}

func (r *probeRuntime) authHeaders() map[string]string {
	return map[string]string{
		"Authorization":    "Bearer " + r.state.Credential,
		"X-Robin-Agent-Id": r.state.AgentID,
	}
}

func (r *probeRuntime) endpoint(path string) string {
	return strings.TrimRight(r.config.adminURL, "/") + path
}

func (r *probeRuntime) fetchManifest(ctx context.Context, etag string) (*remoteProbeManifest, string, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.endpoint("/api/fleet/agent/probes/manifest"), nil)
	if err != nil {
		return nil, etag, 0, err
	}
	for name, value := range r.authHeaders() {
		req.Header.Set(name, value)
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	response, err := r.client.Do(req)
	if err != nil {
		return nil, etag, 0, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified {
		return nil, response.Header.Get("ETag"), response.StatusCode, nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 5*1024*1024+1))
	if err != nil {
		return nil, etag, response.StatusCode, err
	}
	if len(body) > 5*1024*1024 {
		return nil, etag, response.StatusCode, errors.New("probe manifest exceeds the response limit")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, etag, response.StatusCode, fmt.Errorf("probe manifest request failed (HTTP %d)", response.StatusCode)
	}
	var envelope struct {
		Success bool                `json:"success"`
		Error   string              `json:"error"`
		Data    remoteProbeManifest `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, etag, response.StatusCode, err
	}
	if !envelope.Success {
		return nil, etag, response.StatusCode, errors.New("probe manifest response was unsuccessful")
	}
	if err := validateRemoteProbeManifest(envelope.Data); err != nil {
		return nil, etag, response.StatusCode, err
	}
	return &envelope.Data, response.Header.Get("ETag"), response.StatusCode, nil
}

func validateRemoteProbeManifest(manifest remoteProbeManifest) error {
	if manifest.ProtocolVersion != 1 || manifest.ManifestRevision < 1 || manifest.LocationID < 1 ||
		manifest.Concurrency < 1 || manifest.Concurrency > 128 || len(manifest.Checks) > 5000 {
		return errors.New("probe manifest metadata is invalid or unsupported")
	}
	for _, check := range manifest.Checks {
		if check.CheckID < 1 || !check.Enabled || check.IntervalSeconds < 10 || check.IntervalSeconds > 86400 ||
			check.TimeoutSeconds < 1 || check.TimeoutSeconds > 120 {
			return errors.New("probe manifest contains an invalid check")
		}
	}
	return nil
}

func loadProbeObservationBuffer(file string) ([]remoteProbeObservation, error) {
	handle, err := os.Open(file)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer handle.Close()
	data, err := io.ReadAll(io.LimitReader(handle, probeObservationMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > probeObservationMaxBytes {
		return nil, errors.New("probe observation buffer exceeds the size limit")
	}
	var observations []remoteProbeObservation
	if err := json.Unmarshal(data, &observations); err != nil {
		return nil, err
	}
	return boundProbeObservationBuffer(observations, time.Now()), nil
}

func boundProbeObservationBuffer(observations []remoteProbeObservation, now time.Time) []remoteProbeObservation {
	kept := observations[:0]
	cutoff := now.Add(-probeObservationMaxAge)
	for _, observation := range observations {
		if observation.FinishedAt.After(cutoff) {
			kept = append(kept, observation)
		}
	}
	for len(kept) > probeObservationMaxCount {
		kept = kept[1:]
	}
	for len(kept) > 0 {
		data, err := json.Marshal(kept)
		if err == nil && len(data) <= probeObservationMaxBytes {
			break
		}
		kept = kept[1:]
	}
	return kept
}

func saveProbeObservationBuffer(file string, observations []remoteProbeObservation) error {
	data, err := json.Marshal(observations)
	if err != nil {
		return err
	}
	if len(data) > probeObservationMaxBytes {
		return errors.New("probe observation buffer exceeds the size limit")
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	handle, err := os.CreateTemp(filepath.Dir(file), ".probe-observations-*")
	if err != nil {
		return err
	}
	temporary := handle.Name()
	defer os.Remove(temporary)
	if err := handle.Chmod(0600); err != nil {
		_ = handle.Close()
		return err
	}
	if _, err := handle.Write(data); err != nil {
		_ = handle.Close()
		return err
	}
	if err := handle.Sync(); err != nil {
		_ = handle.Close()
		return err
	}
	if err := handle.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, file)
}

func checkJitter(seed, intervalSeconds int) time.Duration {
	width := time.Duration(intervalSeconds) * time.Second / 10
	if width <= 0 {
		return 0
	}
	span := int64(width*2 + 1)
	return time.Duration(int64(seed)%span - int64(width))
}

func (r *probeRuntime) uploadBatch(ctx context.Context, batch []remoteProbeObservation) (int, error) {
	body, err := json.Marshal(map[string]any{"observations": batch})
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint("/api/fleet/agent/probes/observations"), bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	for name, value := range r.authHeaders() {
		req.Header.Set(name, value)
	}
	response, err := r.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, fmt.Errorf("probe observation upload failed (HTTP %d)", response.StatusCode)
	}
	var envelope struct {
		Success bool `json:"success"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&envelope); err != nil {
		return response.StatusCode, err
	}
	if !envelope.Success {
		return response.StatusCode, errors.New("probe observation upload was unsuccessful")
	}
	return response.StatusCode, nil
}

func (r *probeRuntime) run(ctx context.Context) {
	bufferPath := r.config.statePath + ".probe-observations.json"
	buffer, err := loadProbeObservationBuffer(bufferPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "robin-agent: could not load probe observation buffer: %v\n", err)
	}
	flushTicker := time.NewTicker(probeObservationFlushInterval)
	defer flushTicker.Stop()
	scheduleTicker := time.NewTicker(250 * time.Millisecond)
	defer scheduleTicker.Stop()

	enabled := false
	manifestETag := ""
	var manifest *remoteProbeManifest
	nextPoll := time.Time{}
	nextRun := map[int]time.Time{}
	inFlight := map[int]probeRun{}
	var runCounter uint64
	completed := make(chan remoteProbeResult, 128)
	disableProbe := func() {
		enabled = false
		manifest = nil
		manifestETag = ""
		nextPoll = time.Time{}
		nextRun = map[int]time.Time{}
		for id, inflight := range inFlight {
			inflight.cancel()
			delete(inFlight, id)
		}
	}

	appendResult := func(observation remoteProbeObservation) {
		buffer = append(buffer, observation)
		buffer = boundProbeObservationBuffer(buffer, time.Now())
		if err := saveProbeObservationBuffer(bufferPath, buffer); err != nil {
			fmt.Fprintf(os.Stderr, "robin-agent: could not persist probe observations: %v\n", err)
		}
	}
	pollManifest := func() {
		pollCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		nextPoll = time.Now().Add(probeManifestPollInterval)
		fetched, etag, status, err := r.fetchManifest(pollCtx, manifestETag)
		if status == http.StatusForbidden {
			disableProbe()
			return
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "robin-agent: probe manifest: %v\n", err)
			return
		}
		manifestETag = etag
		if fetched != nil {
			manifest = fetched
			nextRun = make(map[int]time.Time, len(fetched.Checks))
			now := time.Now()
			for _, check := range fetched.Checks {
				nextRun[check.CheckID] = now.Add(time.Duration(check.JitterSeed%3000) * time.Millisecond)
			}
			enabled = true
		}
	}
	uploadObservations := func() {
		if !enabled || len(buffer) == 0 {
			return
		}
		buffer = boundProbeObservationBuffer(buffer, time.Now())
		if len(buffer) == 0 {
			_ = saveProbeObservationBuffer(bufferPath, buffer)
			return
		}
		count := min(len(buffer), probeObservationBatchSize)
		uploadCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		status, err := r.uploadBatch(uploadCtx, buffer[:count])
		cancel()
		if err != nil {
			if status == http.StatusForbidden {
				disableProbe()
			} else if status == http.StatusBadRequest {
				buffer = append([]remoteProbeObservation(nil), buffer[count:]...)
				if saveErr := saveProbeObservationBuffer(bufferPath, buffer); saveErr != nil {
					fmt.Fprintf(os.Stderr, "robin-agent: could not discard rejected probe observations: %v\n", saveErr)
				}
			} else if status == http.StatusConflict && manifest != nil {
				currentRevision := manifest.ManifestRevision
				kept := buffer[:0]
				for _, observation := range buffer {
					if observation.ManifestRevision == currentRevision {
						kept = append(kept, observation)
					}
				}
				buffer = kept
				if saveErr := saveProbeObservationBuffer(bufferPath, buffer); saveErr != nil {
					fmt.Fprintf(os.Stderr, "robin-agent: could not discard stale probe observations: %v\n", saveErr)
				}
			}
			fmt.Fprintf(os.Stderr, "robin-agent: probe observation upload: %v\n", err)
			return
		}
		buffer = append([]remoteProbeObservation(nil), buffer[count:]...)
		if err := saveProbeObservationBuffer(bufferPath, buffer); err != nil {
			fmt.Fprintf(os.Stderr, "robin-agent: could not update probe observation buffer: %v\n", err)
		}
	}

	for {
		select {
		case <-ctx.Done():
			for _, inflight := range inFlight {
				inflight.cancel()
			}
			return
		case enabled = <-r.enabled:
			if !enabled {
				disableProbe()
			} else {
				nextPoll = time.Time{}
			}
		case result := <-completed:
			if current, ok := inFlight[result.checkID]; ok && current.run == result.run {
				delete(inFlight, result.checkID)
			}
			if !result.cancelled {
				appendResult(result.value)
			}
		case <-flushTicker.C:
			uploadObservations()
		case now := <-scheduleTicker.C:
			if enabled && (nextPoll.IsZero() || !now.Before(nextPoll)) {
				pollManifest()
			}
			if !enabled || manifest == nil {
				continue
			}
			for _, check := range manifest.Checks {
				if _, running := inFlight[check.CheckID]; running || now.Before(nextRun[check.CheckID]) {
					continue
				}
				if len(inFlight) >= manifest.Concurrency {
					break
				}
				check := check
				startedAt := time.Now().UTC()
				nextRun[check.CheckID] = time.Now().Add(time.Duration(check.IntervalSeconds)*time.Second + checkJitter(check.JitterSeed, check.IntervalSeconds))
				checkCtx, cancel := context.WithCancel(ctx)
				runCounter++
				run := runCounter
				inFlight[check.CheckID] = probeRun{run: run, cancel: cancel}
				revision := manifest.ManifestRevision
				go func() {
					result := runProbe(checkCtx, check)
					cancelled := checkCtx.Err() != nil
					cancel()
					finishedAt := time.Now().UTC()
					details := result.Details
					if details == nil {
						details = map[string]any{}
					}
					if len(details) > 32 {
						details = map[string]any{"detailsTruncated": true}
					} else if encoded, err := json.Marshal(details); err != nil || len(encoded) > 8192 {
						details = map[string]any{"detailsTruncated": true}
					}
					completed <- remoteProbeResult{
						checkID:   check.CheckID,
						run:       run,
						cancelled: cancelled,
						value: remoteProbeObservation{
							CheckID: check.CheckID, ManifestRevision: revision,
							StartedAt: startedAt, FinishedAt: finishedAt,
							Status: result.Status, ErrorCode: result.ErrorCode, Warning: result.Warning,
							ResponseTimeMs: result.ResponseTimeMs, DNSTimeMs: result.DNSTimeMs, Details: details,
						},
					}
				}()
			}
		}
	}
}
