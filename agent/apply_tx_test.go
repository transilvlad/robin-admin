package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// postfixServer serves a manifest of .cf files with the given contents.
func postfixServer(t *testing.T, files map[string]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/fleet/agent/services/pf1/manifest" {
			var entries []string
			for name := range files {
				entries = append(entries, `{"fileName":"`+name+`","payloadKind":"text"}`)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"serviceId":"pf1","serviceType":"postfix","sha256":"m","files":[` + strings.Join(entries, ",") + `]}}`))
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/api/fleet/agent/services/pf1/files/")
		content, ok := files[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"data":{"fileName":"` + name + `","payloadKind":"text","payload":` + jsonString(content) + `}}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func jsonString(value string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), "\n", `\n`) + `"`
}

// fakeCommands records apply steps and fails the one named in failOn.
func fakeCommands(t *testing.T, failOn string, postconfN string) *[]string {
	t.Helper()
	var ran []string
	previous := runApplyCommand
	runApplyCommand = func(_ context.Context, argv []string) ([]byte, error) {
		ran = append(ran, strings.Join(argv, " "))
		if argv[0] == failOn {
			return []byte("fatal: bad config"), errors.New("exit status 1")
		}
		if len(argv) > 1 && argv[0] == "postconf" && argv[1] == "-n" {
			return []byte(postconfN), nil
		}
		return nil, nil
	}
	t.Cleanup(func() { runApplyCommand = previous })
	return &ran
}

func TestApplyRestoresPreviousConfigWhenValidationFails(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "etc", "postfix")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "robin-tls.cf"), []byte("smtpd_tls_security_level = may\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := postfixServer(t, map[string]string{"robin-tls.cf": "smtpd_tls_security_level = encrypt\n", "robin-new.cf": "smtpd_banner = hi\n"})
	ran := fakeCommands(t, "postfix", "smtpd_tls_security_level = may\n")

	c := config{adminURL: srv.URL, managedRoot: root, execPrefix: map[string]string{}}
	s := state{AgentID: "a1", Credential: "cred", LastApplied: map[string]string{}}
	result := applyService(context.Background(), srv.Client(), c, s, ownedService{ServiceID: "pf1", ServiceType: "postfix"})

	if result.status != "failed" || !strings.Contains(result.message, "previous config restored") {
		t.Fatalf("applyService = %+v; want failed with the previous config restored", result)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "robin-tls.cf")); string(data) != "smtpd_tls_security_level = may\n" {
		t.Fatalf("changed file not restored: %q", data)
	}
	if _, err := os.Stat(filepath.Join(dir, "robin-new.cf")); !os.IsNotExist(err) {
		t.Fatalf("new file not removed on rollback: %v", err)
	}
	joined := strings.Join(*ran, "\n")
	for _, want := range []string{"postconf -e smtpd_tls_security_level=may", "postconf -X smtpd_banner"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("main.cf not restored with %q; ran:\n%s", want, joined)
		}
	}
}

func TestApplyDeletesFilesDroppedFromTheManifest(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "etc", "postfix")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "robin-old.cf"), []byte("smtpd_banner = old\nmyhostname = mx\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.cf"), []byte("unmanaged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := postfixServer(t, map[string]string{"robin-tls.cf": "myhostname = mx\n"})
	ran := fakeCommands(t, "", "smtpd_banner = old\nmyhostname = mx\n")

	c := config{adminURL: srv.URL, managedRoot: root, execPrefix: map[string]string{}}
	s := state{AgentID: "a1", Credential: "cred", LastApplied: map[string]string{}, AppliedFiles: map[string][]string{"pf1": {"robin-old.cf", "../main.cf"}}}
	result := applyService(context.Background(), srv.Client(), c, s, ownedService{ServiceID: "pf1", ServiceType: "postfix"})

	if result.status != "succeeded" || strings.Join(result.applied, ",") != "robin-tls.cf" || !strings.Contains(result.message, "1 removed") {
		t.Fatalf("applyService = %+v; want succeeded with one file removed", result)
	}
	if _, err := os.Stat(filepath.Join(dir, "robin-old.cf")); !os.IsNotExist(err) {
		t.Fatalf("dropped file still present: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "main.cf")); err != nil {
		t.Fatalf("a name outside the managed directory was touched: %v", err)
	}
	// myhostname is still set by a current file, so only smtpd_banner goes.
	if joined := strings.Join(*ran, "\n"); !strings.Contains(joined, "postconf -X smtpd_banner\n") || strings.Contains(joined, "-X smtpd_banner myhostname") {
		t.Fatalf("unexpected postconf steps:\n%s", joined)
	}
}
