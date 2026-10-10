package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBoundProbeObservationBufferDropsExpiredEntries(t *testing.T) {
	now := time.Now()
	observations := []remoteProbeObservation{
		{CheckID: 1, FinishedAt: now.Add(-probeObservationMaxAge - time.Second)},
		{CheckID: 2, FinishedAt: now.Add(3 * time.Minute)},
		{CheckID: 3, FinishedAt: now.Add(-time.Minute)},
	}
	bounded := boundProbeObservationBuffer(observations, now)
	if len(bounded) != 2 || bounded[0].CheckID != 2 || bounded[1].CheckID != 3 {
		t.Fatalf("buffer = %#v; want the future and recent observations only", bounded)
	}
}

func TestHeartbeatAdvertisesProbeProtocolAndReadsCapabilityGrant(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer probe-credential" || r.Header.Get("X-Robin-Agent-Id") != "probe-agent" {
			http.Error(w, "missing agent auth", http.StatusUnauthorized)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid heartbeat", http.StatusBadRequest)
			return
		}
		if body["probeProtocolVersion"] != float64(1) {
			http.Error(w, "probe protocol not advertised", http.StatusBadRequest)
			return
		}
		clientTime, ok := body["clientTime"].(string)
		if !ok {
			http.Error(w, "client time not reported", http.StatusBadRequest)
			return
		}
		if _, err := time.Parse(time.RFC3339Nano, clientTime); err != nil {
			http.Error(w, "client time not reported", http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, `{"success":true,"data":{"probeEnabled":true}}`)
	}))
	defer server.Close()
	enabled, err := heartbeat(newHTTPClient(false), config{adminURL: server.URL}, state{
		AgentID: "probe-agent", Credential: "probe-credential",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !enabled {
		t.Fatal("heartbeat did not return the probe capability grant")
	}
}

func TestProbeRuntimePullsSchedulesAndUploadsWithoutPersistingManifestSecrets(t *testing.T) {
	const manifestSecret = "runtime-manifest-secret"
	var bufferPath string
	probeRequests := make(chan string, 1)
	probeServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probeRequests <- r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	}))
	defer probeServer.Close()

	uploaded := make(chan []byte, 1)
	adminRequests := make(chan string, 4)
	adminServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminRequests <- r.URL.Path
		if r.Header.Get("Authorization") != "Bearer probe-credential" || r.Header.Get("X-Robin-Agent-Id") != "probe-agent" {
			http.Error(w, "missing agent auth", http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/api/fleet/agent/probes/manifest" && r.Method == http.MethodGet {
			if r.Header.Get("If-None-Match") == `"r1"` {
				w.Header().Set("ETag", `"r1"`)
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", `"r1"`)
			w.Header().Set("Content-Type", "application/json")
			manifest := map[string]any{
				"protocolVersion": 1, "manifestRevision": 1, "generatedAt": time.Now().UTC(),
				"locationId": 4, "concurrency": 2,
				"checks": []probeCheck{{
					CheckID: 7, Name: "Runtime probe", CheckType: "http", Endpoint: probeServer.URL,
					IntervalSeconds: 60, TimeoutSeconds: 3, ConfirmationSeconds: 0, RecoverySeconds: 0,
					TLSMode: "allow_self_signed", CertificateErrorMode: "down", AllowPrivate: true,
					Options:       json.RawMessage(`{"http":{"method":"GET","headers":{},"body":"","expectedStatuses":[200],"followRedirects":false,"maxRedirects":0,"maxResponseTimeMs":null,"assertions":[]}}`),
					SecretHeaders: map[string]string{"authorization": manifestSecret}, Enabled: true, JitterSeed: 0,
				}},
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": manifest})
			return
		}
		if r.URL.Path == "/api/fleet/agent/probes/observations" && r.Method == http.MethodPost {
			body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
			if err != nil {
				http.Error(w, "read failed", http.StatusInternalServerError)
				return
			}
			if strings.Contains(string(body), manifestSecret) {
				http.Error(w, "manifest secret was uploaded", http.StatusBadRequest)
				return
			}
			if persisted, err := os.ReadFile(bufferPath); err != nil || strings.Contains(string(persisted), manifestSecret) {
				http.Error(w, "manifest secret was persisted", http.StatusBadRequest)
				return
			}
			uploaded <- body
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{"success":true,"data":{"inserted":1,"duplicates":0}}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer adminServer.Close()

	bufferPath = filepath.Join(t.TempDir(), "state.json") + ".probe-observations.json"
	cfg := config{adminURL: adminServer.URL, statePath: strings.TrimSuffix(bufferPath, ".probe-observations.json")}
	agentState := state{AgentID: "probe-agent", Credential: "probe-credential"}
	probeAgent := newProbeRuntime(newHTTPClient(false), cfg, agentState, true)
	ctx, cancel := context.WithCancel(context.Background())
	// Wait for the runtime to stop so it cannot write its observation buffer
	// while the temporary directory is being removed.
	stopped := make(chan struct{})
	go func() { probeAgent.run(ctx); close(stopped) }()
	defer func() { cancel(); <-stopped }()

	select {
	case auth := <-probeRequests:
		if auth != "runtime-manifest-secret" {
			t.Fatalf("probe Authorization = %q", auth)
		}
	case <-time.After(8 * time.Second):
		select {
		case body := <-uploaded:
			t.Fatalf("probe was not issued; uploaded result %s; admin requests: %v", body, drainStrings(adminRequests))
		default:
			t.Fatalf("probe was not scheduled; admin requests: %v", drainStrings(adminRequests))
		}
	}

	select {
	case body := <-uploaded:
		var payload struct {
			Observations []remoteProbeObservation `json:"observations"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if len(payload.Observations) != 1 || payload.Observations[0].CheckID != 7 ||
			payload.Observations[0].ManifestRevision != 1 || payload.Observations[0].Status != "up" {
			t.Fatalf("uploaded observations = %#v", payload.Observations)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("probe observation was not uploaded")
	}
}

func drainStrings(values chan string) []string {
	var result []string
	for {
		select {
		case value := <-values:
			result = append(result, value)
		default:
			return result
		}
	}
}
