package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestCyrusCommands(t *testing.T) {
	cases := []struct {
		action string
		args   map[string]any
		want   [][]string
	}{
		{"cyrus.sessions", nil, [][]string{{"cyr_info", "proc"}}},
		{"cyrus.quota", nil, [][]string{{"quota"}}},
		{"cyrus.quota", map[string]any{"user": "happy@example.com"}, [][]string{{"quota", "user/happy@example.com"}}},
		{"cyrus.user", map[string]any{"user": "happy@example.com"}, [][]string{{"mbpath", "-u", "--", "happy@example.com"}}},
	}
	for _, tc := range cases {
		got, err := commandSpecs[tc.action].build(tc.args)
		if err != nil || !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %v, %v; want %v", tc.action, got, err, tc.want)
		}
	}
	for _, bad := range []any{"-C/etc/passwd", "user;id", "user/name", "user\nname", "a b", 42} {
		for _, action := range []string{"cyrus.quota", "cyrus.user"} {
			if _, err := commandSpecs[action].build(map[string]any{"user": bad}); err == nil {
				t.Errorf("%s accepted %q", action, bad)
			}
		}
	}
	if _, err := commandSpecs["cyrus.user"].build(nil); err == nil {
		t.Error("user action accepted an absent user")
	}
	if _, err := runCommand(context.Background(), config{}, agentCommand{Action: "cyrus.sessions", ServiceType: "dovecot"}); err == nil {
		t.Error("wrong service type accepted")
	}
	if _, ok := commandSpecs["cyrus.kick"]; ok {
		t.Error("Cyrus must not offer kick")
	}
	if _, ok := commandSpecs["cyrus.reload"]; ok {
		t.Error("Cyrus must not offer reload")
	}
}

func TestCyrusCapabilities(t *testing.T) {
	svc := ownedService{ServiceID: "imap", ServiceType: "cyrus", CollectMetrics: true}
	actions := serviceActions(config{}, svc, func(_ string, tool string) bool { return tool != "mbpath" })
	if !reflect.DeepEqual(actions, []string{"cyrus.quota", "cyrus.sessions"}) {
		t.Fatalf("unexpected actions: %v", actions)
	}
	actions = serviceActions(config{}, svc, func(_, _ string) bool { return true })
	if !reflect.DeepEqual(actions, []string{"cyrus.quota", "cyrus.sessions", "cyrus.user"}) {
		t.Fatalf("unexpected actions: %v", actions)
	}
}

func TestCyrusCollectorsAndPrefix(t *testing.T) {
	samples := metricsCollectors["cyrus"]
	if len(samples) != 3 || samples[0].field != "prometheus" || !reflect.DeepEqual(samples[0].argv, []string{"cat", "/var/lib/cyrus/config/stats/report.txt"}) {
		t.Fatalf("unexpected collectors: %v", samples)
	}
	if samples[1].field != "proc" || !reflect.DeepEqual(samples[1].argv, []string{"cyr_info", "proc"}) {
		t.Fatal("missing process collector")
	}
	if samples[2].field != "version" || !samples[2].combined || !reflect.DeepEqual(samples[2].argv, []string{"master", "-V"}) {
		t.Fatal("missing version collector")
	}
	c := config{execPrefix: map[string]string{"imap": "docker exec mailbox"}}
	if got := strings.Join(c.execArgv("imap", samples[1].argv), " "); got != "docker exec mailbox cyr_info proc" {
		t.Fatal(got)
	}
	if _, ok := applyRecipes["cyrus"]; ok {
		t.Fatal("Cyrus must not manage config")
	}
}

func TestCyrusLogOverride(t *testing.T) {
	src, ok := resolveLogSource("cyrus", "imap")
	if !ok || src.unit != "cyrus-imapd" || src.file != "/var/log/mail.log" || src.filter != "cyrus/" {
		t.Fatalf("unexpected log source: %+v", src)
	}
	t.Setenv("ROBIN_AGENT_CYRUS_LOG_FILE", "/logs/cyrus/cyrus.log")
	src, ok = resolveLogSource("cyrus", "imap")
	if !ok || src.file != "/logs/cyrus/cyrus.log" || src.filter != "" {
		t.Fatalf("unexpected overridden log: %+v", src)
	}
}

func TestCyrusCollectorHelper(t *testing.T) {
	if os.Getenv("ROBIN_TEST_CYRUS_COLLECTOR") != "1" {
		return
	}
	switch os.Args[len(os.Args)-1] {
	case "report":
		fmt.Println("cyrus_imap_active_connections 1 1761140000000")
	case "version":
		fmt.Fprintln(os.Stderr, "cyrus-imapd 3.6.1")
	}
	os.Exit(0)
}

func TestCyrusMetricsPush(t *testing.T) {
	t.Setenv("ROBIN_TEST_CYRUS_COLLECTOR", "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	previous := metricsCollectors["cyrus"]
	t.Cleanup(func() { metricsCollectors["cyrus"] = previous })
	sample := func(field, mode string, combined bool) metricsSample {
		return metricsSample{field: field, argv: []string{executable, "-test.run=^TestCyrusCollectorHelper$", "--", mode}, combined: combined}
	}
	metricsCollectors["cyrus"] = []metricsSample{sample("prometheus", "report", false), sample("proc", "proc", false), sample("version", "version", true)}
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()
	pushServiceMetrics(context.Background(), server.Client(), config{adminURL: server.URL}, state{}, ownedService{ServiceID: "imap", ServiceType: "cyrus"})
	if body["reachable"] != true || body["proc"] != "" || body["version"] != "cyrus-imapd 3.6.1\n" || !strings.Contains(fmt.Sprint(body["prometheus"]), "cyrus_imap_active_connections") {
		t.Fatalf("unexpected body: %+v", body)
	}
}
