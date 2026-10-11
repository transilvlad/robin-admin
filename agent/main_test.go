package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCommandDiagnosticsDoNotIncludeArguments(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	cmd := agentCommand{ID: "diagnostic-command", ServiceID: "fixture", Action: "postfix.queue.list", Args: map[string]any{"password": "never-log-this"}}
	logCommandEvent("result_delivery_retry", cmd, time.Now(), 2, 503, "")
	line := output.String()
	if strings.Contains(line, "never-log-this") || strings.Contains(line, "password") {
		t.Fatal("command arguments leaked into diagnostics")
	}
	var event map[string]any
	if err := json.Unmarshal([]byte(line[strings.Index(line, "{"):]), &event); err != nil {
		t.Fatal(err)
	}
	if event["commandId"] != cmd.ID || event["attempt"] != float64(2) || event["httpStatus"] != float64(503) {
		t.Fatalf("missing lifecycle correlation: %v", event)
	}
}

func TestCommandHelper(t *testing.T) {
	path := os.Getenv("ROBIN_TEST_COMMAND_EXECUTIONS")
	if path == "" {
		return
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.WriteString("executed\n"); err != nil {
		t.Fatal(err)
	}
}

func TestPollCommandsDoesNotReplayDuplicateDelivery(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "executions")
	t.Setenv("ROBIN_TEST_COMMAND_EXECUTIONS", path)
	const action = "test.once"
	commandSpecs[action] = commandSpec{"postfix", fixed(executable, "-test.run=^TestCommandHelper$")}
	defer delete(commandSpecs, action)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var polls, results atomic.Int32
	var acked atomic.Bool
	delivered := make(chan struct{})
	var deliveredOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/result") {
			if results.Add(1) == 1 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.WriteHeader(http.StatusOK)
			deliveredOnce.Do(func() { close(delivered) })
			return
		}
		if r.URL.Query().Get("ack") == "duplicate-command" {
			acked.Store(true)
		}
		if polls.Add(1) <= 3 {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": []agentCommand{{ID: "duplicate-command", ServiceID: "fixture", ServiceType: "postfix", Action: action}}})
			return
		}
		select {
		case <-ctx.Done():
		case <-delivered:
		}
		_, _ = w.Write([]byte(`{"success":true,"data":[]}`))
	}))
	defer server.Close()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		pollCommands(ctx, config{adminURL: server.URL}, state{AgentID: "fixture", Credential: "fixture"}, &actionSet{actions: []string{action}})
	}()
	select {
	case <-delivered:
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("result retry did not finish")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("command poll did not stop")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "executed\n" {
		t.Fatalf("command must execute exactly once during duplicate delivery: %q, %v", data, err)
	}
	if results.Load() != 2 || !acked.Load() {
		t.Fatalf("expected acknowledgement and two result delivery attempts: acked=%v results=%d", acked.Load(), results.Load())
	}
}

func TestCommandResultRetriesTransientFailure(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture" {
			t.Error("credential missing from result retry")
		}
		if requests.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	if err := reportCommandResult(context.Background(), server.Client(), server.URL, map[string]string{"Authorization": "Bearer fixture"}, map[string]any{"ok": true, "output": "once"}, agentCommand{ID: "retry"}); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 2 {
		t.Fatalf("expected two deliveries, got %d", requests.Load())
	}
}

func TestCommandResultStopsOnTerminalRejection(t *testing.T) {
	for _, code := range []int{401, 403, 404, 409} {
		var requests atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests.Add(1)
			w.WriteHeader(code)
		}))
		err := reportCommandResult(context.Background(), server.Client(), server.URL, nil, map[string]any{"ok": true}, agentCommand{ID: "rejected"})
		server.Close()
		if err == nil || requests.Load() != 1 {
			t.Fatalf("HTTP %d must stop without replay: requests=%d, error=%v", code, requests.Load(), err)
		}
	}
}

func TestCommandResultCancellationBoundsStalledRequest(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	if err := reportCommandResult(ctx, server.Client(), server.URL, nil, map[string]any{"ok": true}, agentCommand{ID: "deadline"}); err == nil {
		t.Fatal("cancelled delivery must fail")
	}
	if time.Since(started) > time.Second {
		t.Fatal("cancelled delivery exceeded deadline")
	}
}

func TestMetricsObservationBody(t *testing.T) {
	success := metricsObservationBody(map[string]any{"stats": "ok"}, true, "")
	if success["reachable"] != true {
		t.Fatal("successful observations must include reachable=true")
	}
	if _, exists := success["errorCode"]; exists {
		t.Fatal("successful observations must not include an error code")
	}

	failure := metricsObservationBody(map[string]any{}, false, "collection_failed")
	if failure["reachable"] != false {
		t.Fatal("failed observations must include reachable=false")
	}
	if failure["errorCode"] != "collection_failed" {
		t.Fatal("failed observations must include a bounded error code")
	}
}

func TestPostconfSettings(t *testing.T) {
	got := postconfSettings("# Managed by Robin Admin\nmessage_size_limit = 20480000\n\nnotify_classes = resource, software\n")
	want := []string{"message_size_limit=20480000", "notify_classes=resource, software"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("postconfSettings = %q, want %q", got, want)
	}
}

func TestCommandSpecsValidateArguments(t *testing.T) {
	argvs, err := commandSpecs["postfix.queue.delete"].build(map[string]any{"queueIds": []any{"4F1A2B3C4D", "ABCDE12345"}})
	if err != nil || strings.Join(argvs[0], " ") != "postsuper -d 4F1A2B3C4D -d ABCDE12345" {
		t.Fatalf("delete argv = %v, %v", argvs, err)
	}
	for _, bad := range []any{"ALL", "../x", "-d", "ab"} {
		if _, err := commandSpecs["postfix.queue.delete"].build(map[string]any{"queueIds": []any{bad}}); err == nil {
			t.Fatalf("queue ID %q must be rejected", bad)
		}
	}
	for _, bad := range []string{"-f", "a b", "a;rm", "*", ""} {
		if _, err := commandSpecs["dovecot.kick"].build(map[string]any{"user": bad}); err == nil {
			t.Fatalf("user %q must be rejected", bad)
		}
	}
	if argvs, err := commandSpecs["dovecot.quota"].build(map[string]any{}); err != nil || argvs[0][len(argvs[0])-1] != "-A" {
		t.Fatalf("quota without a user must list all users: %v, %v", argvs, err)
	}
	if _, err := runCommand(context.Background(), config{}, agentCommand{Action: "postfix.queue.list", ServiceType: "dovecot"}); err == nil {
		t.Fatal("an action must only run for its own service type")
	}
}

func TestReadFromShipsOnlyCompleteNewLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mail.log")
	if err := os.WriteFile(path, []byte("one\ntwo\npart"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, offset, info, err := readFrom(path, 0, nil)
	if err != nil || strings.Join(lines, ",") != "one,two" || offset != 8 {
		t.Fatalf("first read = %q @%d, %v", lines, offset, err)
	}
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = f.WriteString("ial\nthree\n")
	_ = f.Close()
	lines, offset, info, _ = readFrom(path, offset, info)
	if strings.Join(lines, ",") != "partial,three" {
		t.Fatalf("second read = %q", lines)
	}
	// A truncated (shrunken) file is read from the start.
	_ = os.WriteFile(path, []byte("new\n"), 0o644)
	if lines, _, info, _ = readFrom(path, offset, info); strings.Join(lines, ",") != "new" {
		t.Fatalf("after truncation = %q", lines)
	}
	// So is a rotated file that already grew past the old offset.
	_ = os.Rename(path, path+".1")
	_ = os.WriteFile(path, []byte("first line after rotation\nsecond\n"), 0o644)
	if lines, _, _, _ = readFrom(path, 4, info); strings.Join(lines, ",") != "first line after rotation,second" {
		t.Fatalf("after rotation = %q", lines)
	}
}

func TestPushServiceLogsSendsEmptyBatchAsArray(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rspamd.log")
	if err := os.WriteFile(path, []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_FILE", path)

	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	svc := ownedService{ServiceID: "svc-empty-batch", ServiceType: "rspamd"}
	defer delete(logCursors, svc.ServiceID)
	c := config{adminURL: srv.URL}
	pushServiceLogs(context.Background(), srv.Client(), c, state{AgentID: "a", Credential: "c"}, svc) // reset tail
	pushServiceLogs(context.Background(), srv.Client(), c, state{AgentID: "a", Credential: "c"}, svc) // quiet cycle

	if len(bodies) != 2 || bodies[0]["reset"] != true || bodies[1]["reset"] != false {
		t.Fatalf("unexpected pushes: %v", bodies)
	}
	if lines, ok := bodies[1]["lines"].([]any); !ok || len(lines) != 0 {
		t.Fatalf("quiet cycle must send lines: [], got %#v", bodies[1]["lines"])
	}
	if logCursors[svc.ServiceID] == nil {
		t.Fatal("a successful quiet push must keep the cursor")
	}
}

func TestSeenCommandsSkipsResentIDs(t *testing.T) {
	seen := newSeenCommands()
	if !seen.add("a") {
		t.Fatal("first sighting should be new")
	}
	if seen.add("a") {
		t.Fatal("re-sent id should be skipped")
	}
	seen.ids["a"] = time.Now().Add(-2 * seenCommandTTL)
	if !seen.add("a") {
		t.Fatal("expired id should be new again")
	}
}

func TestContainerExecTarget(t *testing.T) {
	cases := map[string][2]string{
		"docker exec suite-dovecot":   {"docker", "suite-dovecot"},
		"docker exec -u root mail":    {"docker", "mail"},
		"/usr/bin/podman exec -i mx1": {"/usr/bin/podman", "mx1"},
		"ssh mail1":                   {"", ""},
		"":                            {"", ""},
		"docker exec -it":             {"", ""},
		"kubectl exec pod -- sh":      {"", ""},
	}
	for prefix, want := range cases {
		cli, container := containerExecTarget(prefix)
		if cli != want[0] || container != want[1] {
			t.Errorf("containerExecTarget(%q) = %q, %q; want %q, %q", prefix, cli, container, want[0], want[1])
		}
	}
}

func TestResolveLogSourcePerService(t *testing.T) {
	t.Setenv("ROBIN_AGENT_POSTFIX_LOG_FILTER", "postfix-mx/")
	t.Setenv("ROBIN_AGENT_LOG_MX_2_FILE", "/var/log/mx2/mail.log")
	t.Setenv("ROBIN_AGENT_LOG_MX_3_CONTAINER", "mx3")

	mx1, _ := resolveLogSource("postfix", "mx-1")
	if mx1.file != "/var/log/mail.log" || mx1.filter != "postfix-mx/" || mx1.container != "" {
		t.Errorf("mx-1 should use the type-level settings, got %+v", mx1)
	}
	mx2, _ := resolveLogSource("postfix", "mx-2")
	if mx2.file != "/var/log/mx2/mail.log" || mx2.filter != "" {
		t.Errorf("mx-2 should read its own unfiltered file, got %+v", mx2)
	}
	mx3, _ := resolveLogSource("postfix", "mx-3")
	if mx3.container != "mx3" || mx3.filter != "postfix-mx/" {
		t.Errorf("mx-3 should follow its container with the type filter, got %+v", mx3)
	}
}

func TestApplyServiceReportsWrittenFileCount(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/fleet/agent/services/pf1/manifest":
			_, _ = w.Write([]byte(`{"success":true,"data":{"serviceId":"pf1","serviceType":"postfix","sha256":"abc","files":[` +
				`{"fileName":"robin-tls.cf","payloadKind":"text"},{"fileName":"robin-admin.tls.values.json","payloadKind":"json"}]}}`))
		case "/api/fleet/agent/services/pf1/files/robin-tls.cf":
			_, _ = w.Write([]byte(`{"success":true,"data":{"fileName":"robin-tls.cf","payloadKind":"text","payload":"smtpd_tls_security_level = may\n"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	root := t.TempDir()
	c := config{adminURL: srv.URL, managedRoot: root, applyOnly: true, execPrefix: map[string]string{}}
	s := state{AgentID: "a1", Credential: "cred", LastApplied: map[string]string{}}
	result := applyService(context.Background(), srv.Client(), c, s, ownedService{ServiceID: "pf1", ServiceType: "postfix"})

	// The JSON values payload is metadata, not a file, so one file is written.
	if result.status != "succeeded" || result.files != 1 || result.manifestSha != "abc" {
		t.Fatalf("applyService = %+v; want succeeded with 1 file", result)
	}
	if _, err := os.Stat(filepath.Join(root, "etc", "postfix", "robin-tls.cf")); err != nil {
		t.Fatalf("rendered file not written: %v", err)
	}
}

func TestExecArgvQuotesArgumentsForSSH(t *testing.T) {
	c := config{execPrefix: map[string]string{"pf1": "ssh -o BatchMode=yes mail1", "pf2": "docker exec mx"}}
	got := c.execArgv("pf1", []string{"postconf", "-e", "notify_classes=resource, software", "it's"})
	want := []string{"ssh", "-o", "BatchMode=yes", "mail1", "postconf", "-e", "'notify_classes=resource, software'", `'it'\''s'`}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("ssh execArgv = %q; want %q", got, want)
	}
	// docker exec passes argv straight through; no shell is involved.
	if got := c.execArgv("pf2", []string{"postconf", "-e", "a=b c"}); got[len(got)-1] != "a=b c" {
		t.Errorf("docker execArgv quoted an argument: %q", got)
	}
}

func TestManagedRelPath(t *testing.T) {
	ok := map[string]string{"local.conf": "local.conf", "maps/allow.map": "maps/allow.map", "./a/../b.conf": "b.conf"}
	for in, want := range ok {
		if got, valid := managedRelPath(in); !valid || got != want {
			t.Errorf("managedRelPath(%q) = %q, %v; want %q", in, got, valid, want)
		}
	}
	for _, in := range []string{"../etc/passwd", "/etc/passwd", "..", "", "maps/../../x"} {
		if _, valid := managedRelPath(in); valid {
			t.Errorf("managedRelPath(%q) accepted a path outside the directory", in)
		}
	}
}

func TestApplyServiceKeepsSubdirectoriesAndRefusesSSH(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/fleet/agent/services/rs1/manifest":
			_, _ = w.Write([]byte(`{"success":true,"data":{"serviceId":"rs1","serviceType":"rspamd","sha256":"m1","files":[{"fileName":"maps/allow.map","payloadKind":"text"}]}}`))
		case "/api/fleet/agent/services/rs1/files/maps%2Fallow.map", "/api/fleet/agent/services/rs1/files/maps/allow.map":
			_, _ = w.Write([]byte(`{"success":true,"data":{"fileName":"maps/allow.map","payloadKind":"text","payload":"example.test\n"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	root := t.TempDir()
	s := state{AgentID: "a1", Credential: "cred", LastApplied: map[string]string{}}
	c := config{adminURL: srv.URL, managedRoot: root, applyOnly: true, execPrefix: map[string]string{}}
	if result := applyService(context.Background(), srv.Client(), c, s, ownedService{ServiceID: "rs1", ServiceType: "rspamd"}); result.status != "succeeded" {
		t.Fatalf("applyService = %+v; want succeeded", result)
	}
	if _, err := os.Stat(filepath.Join(root, "etc", "rspamd", "local.d", "maps", "allow.map")); err != nil {
		t.Fatalf("map not written under maps/: %v", err)
	}

	c = config{adminURL: srv.URL, managedRoot: root, execPrefix: map[string]string{"rs1": "ssh mail1"}}
	result := applyService(context.Background(), srv.Client(), c, s, ownedService{ServiceID: "rs1", ServiceType: "rspamd"})
	if result.status != "failed" || !strings.Contains(result.message, "ssh") {
		t.Fatalf("ssh apply = %+v; want failed naming ssh", result)
	}
}

func TestAccessKind(t *testing.T) {
	cases := map[string]string{
		"":                           "local",
		"docker exec suite-postfix":  "container",
		"podman exec -i mx1":         "container",
		"ssh -o BatchMode=yes mail1": "ssh",
		"kubectl exec pod --":        "other",
	}
	for prefix, want := range cases {
		if got := accessKind(prefix); got != want {
			t.Errorf("accessKind(%q) = %q; want %q", prefix, got, want)
		}
	}
}

func TestServiceReportsListOnlyActionsWhoseToolsExist(t *testing.T) {
	c := config{execPrefix: map[string]string{"mx": "ssh mail1"}, applyOnly: true}
	services := []ownedService{
		{ServiceID: "mx", ServiceType: "postfix", CollectMetrics: true},
		{ServiceID: "imap", ServiceType: "dovecot", CollectConfig: true},
		{ServiceID: "logs-only", ServiceType: "postfix", CollectLogs: true},
	}
	// postcat is missing on mx; dovecot has doveadm but no doveconf, and no quota plugin.
	has := func(serviceID, tool string) bool {
		return !(serviceID == "mx" && tool == "postcat") && !(serviceID == "imap" && (tool == "doveconf" || tool == "action:dovecot.quota"))
	}
	reports := serviceReports(c, services, has)

	mx := reports["mx"]
	if mx.Access != "ssh" || mx.FileDelivery || !mx.ApplyOnly {
		t.Errorf("mx report = %+v; want ssh, no file delivery, apply-only", mx)
	}
	joined := strings.Join(mx.Actions, ",")
	if strings.Contains(joined, "postfix.queue.show") || !strings.Contains(joined, "postfix.queue.list") {
		t.Errorf("mx actions = %s; want queue.list without queue.show", joined)
	}
	imap := strings.Join(reports["imap"].Actions, ",")
	if strings.Contains(imap, "dovecot.reload") || strings.Contains(imap, "dovecot.quota") || !strings.Contains(imap, "dovecot.who") {
		t.Errorf("imap actions = %s; want who, but not reload (doveconf missing) or quota (no plugin)", imap)
	}
	if reports["imap"].Access != "local" || !reports["imap"].FileDelivery {
		t.Errorf("imap report = %+v; want local with file delivery", reports["imap"])
	}
	if len(reports["logs-only"].Actions) != 0 {
		t.Errorf("a logs-only service advertised actions: %v", reports["logs-only"].Actions)
	}
}
