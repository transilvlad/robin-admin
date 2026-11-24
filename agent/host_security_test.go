package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixtureSecurityKey() string {
	keyType := []byte("ssh-ed25519")
	blob := binary.BigEndian.AppendUint32(nil, uint32(len(keyType)))
	blob = append(blob, keyType...)
	blob = binary.BigEndian.AppendUint32(blob, 32)
	blob = append(blob, make([]byte, 32)...)
	return base64.StdEncoding.EncodeToString(blob)
}

func TestHostSecurityAuthorizedKey(t *testing.T) {
	material := fixtureSecurityKey()
	item, ok := parseSecurityKey(`from="192.0.2.1,192.0.2.2",command="sample, token=demo",restrict ssh-ed25519 `+material+" test comment", "test", "/home/test/.ssh/authorized_keys")
	if !ok {
		t.Fatal("key was not parsed")
	}
	value := item.Value.(map[string]any)
	if value["bits"] != 256 || value["comment"] != "test comment" || !strings.HasPrefix(value["fingerprint"].(string), "SHA256:") {
		t.Fatalf("unexpected key metadata: %v", value)
	}
	output := fmt.Sprint(value)
	if strings.Contains(output, material) || strings.Contains(output, "demo") || !strings.Contains(output, "from=192.0.2.1,192.0.2.2") {
		t.Fatalf("incorrect key redaction or options: %s", output)
	}
}

func TestHostSecuritySplitPreservesRecordsAndBatchIdentity(t *testing.T) {
	batch := &securityEventBatch{Version: 1, BatchID: strings.Repeat("a", 64),
		Events:   []securityEvent{{ID: "first"}, {ID: "second"}, {ID: "third"}},
		Counters: []securityCounter{{Successful: 2}},
	}
	left, right := splitHostSecurityBatch(batch)
	if left.BatchID == right.BatchID || left.BatchID == batch.BatchID || right.BatchID == batch.BatchID {
		t.Fatal("split batches must have independent receipt keys")
	}
	if len(left.Events) != 2 || left.Events[1].ID != "second" || len(right.Events) != 1 ||
		right.Events[0].ID != "third" || right.Counters[0].Successful != 2 {
		t.Fatalf("split changed record order or counters: %+v %+v", left, right)
	}
	single, rest := splitHostSecurityBatch(&securityEventBatch{Events: []securityEvent{{ID: "first"}}})
	if single != nil || rest != nil {
		t.Fatal("single record cannot be split further")
	}
}

func TestHostSecurityResumesSplitBatchAfterRestart(t *testing.T) {
	sent := make(chan securityEventBatch, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var batch securityEventBatch
		if err := json.NewDecoder(req.Body).Decode(&batch); err != nil {
			http.Error(w, "invalid test payload", http.StatusBadRequest)
			return
		}
		sent <- batch
		if len(batch.Events) > 1 {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "events.json")
	log := securityLogState{Pending: &securityEventBatch{
		Version: 1, BatchID: strings.Repeat("a", 64),
		Events: []securityEvent{{ID: "first"}, {ID: "second"}}, Counters: []securityCounter{},
	}}
	send := func() {
		t.Helper()
		if err := shipHostSecurityEvents(context.Background(), server.Client(), config{adminURL: server.URL},
			state{AgentID: "fixture"}, securityConfig{}, path, &log); err != nil {
			t.Fatal(err)
		}
	}
	send()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	log = securityLogState{}
	if err := json.Unmarshal(raw, &log); err != nil {
		t.Fatal(err)
	}
	send()
	send()
	if len(sent) != 3 || log.Pending != nil || len(log.PendingQueue) != 0 {
		t.Fatal("split records were not delivered after the retry")
	}
	<-sent
	first, second := <-sent, <-sent
	if len(first.Events) != 1 || first.Events[0].ID != "first" ||
		len(second.Events) != 1 || second.Events[0].ID != "second" {
		t.Fatal("split records were delivered out of order")
	}
}

func TestHostSecurityOmitsOversizedInventoryWithoutInventingRemovals(t *testing.T) {
	sections := map[string]securitySection{"integrity": securitySectionResult([]securityItem{
		{ID: "/short", Value: map[string]string{"path": "/short", "sha256": strings.Repeat("a", 64)}},
		{ID: "/long", Value: map[string]string{"path": "/" + strings.Repeat("a", 512), "sha256": strings.Repeat("b", 64)}},
	}, nil)}
	section := fitSecuritySnapshot(sections)["integrity"]
	if section.Complete || len(section.Items) != 1 || section.Items[0].ID != "/short" {
		t.Fatalf("unexpected bounded inventory: %+v", section)
	}
}

func TestHostSecurityForcedCommandCannotInjectOptions(t *testing.T) {
	options := securityKeyOptions(`command="fixture,restrict,from=ignored",from="192.0.2.0/24"`)
	if len(options) != 2 || options[0] != "command=[redacted]" || options[1] != "from=192.0.2.0/24" {
		t.Fatalf("unexpected options: %v", options)
	}
}

func TestHostSecurityCountsOneInvalidLoginPair(t *testing.T) {
	state := &securityLogState{Windows: map[string]*securityCounterWindow{}}
	at := time.Now().UTC().Truncate(time.Minute)
	recordFailedHostLogin(state, "sshd[1]: Invalid user fixture from 192.0.2.10", "invalid_user", "192.0.2.10", at)
	recordFailedHostLogin(state, "sshd[1]: Failed password for invalid user fixture from 192.0.2.10", "invalid_user", "192.0.2.10", at.Add(time.Second))
	recordFailedHostLogin(state, "sshd[1]: Failed password for invalid user fixture from 192.0.2.10", "invalid_user", "192.0.2.10", at.Add(2*time.Second))
	if count := state.Windows[at.Format(time.RFC3339)].Counter.InvalidUser; count != 2 {
		t.Fatalf("wanted two attempts, got %d", count)
	}
}

func TestHostSecurityEffectiveSSHSettings(t *testing.T) {
	items, paths := securitySSHD("port 22\nport 5222\npasswordauthentication no\npermitrootlogin prohibit-password\nauthorizedkeysfile .ssh/authorized_keys /etc/ssh/keys/%u\nsetenv OTHER=SECRET\n")
	if len(items) != 4 || len(paths) != 2 || strings.Contains(fmt.Sprint(items), "SECRET") {
		t.Fatalf("unexpected effective settings %v", items)
	}
}

func TestHostSecurityAuthLogFormats(t *testing.T) {
	cases := []struct{ line, kind, failed, user string }{
		{"Nov 19 10:33:01 debian sshd[42]: Accepted password for test from 192.0.2.10 port 5555 ssh2", "login", "", "test"},
		{"2026-11-19T10:34:00+0000 ubuntu sshd-session[4]: Accepted publickey for test from 2001:db8::2 port 123 ssh2: ED25519 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "login", "", "test"},
		{"Nov 19 10:33:01 rhel sshd[42]: Failed password for invalid user demo from 192.0.2.20 port 123 ssh2", "", "invalid_user", ""},
		{"Nov 19 10:33:01 rhel sshd[42]: Failed publickey for test from 192.0.2.20 port 123 ssh2", "", "failed_key", ""},
		{"Nov 19 10:33:01 rhel sshd[42]: Invalid user demo from 192.0.2.20 port 123", "", "invalid_user", ""},
		{"Nov 19 10:33:01 rhel sudo[2]: test : TTY=pts/1 ; USER=root ; COMMAND=/bin/example SECRET", "sudo", "", "test"},
		{"Nov 19 10:33:01 rhel useradd[2]: new user: name=test, UID=1001", "user_change", "", "test"},
	}
	for _, test := range cases {
		event, failed, _ := classifySecurityLine(test.line, nil)
		if event.Type != test.kind || failed != test.failed || event.User != test.user || strings.Contains(event.Line, "SECRET") {
			t.Fatalf("line %q produced %+v and %s", test.line, event, failed)
		}
		if test.failed != "" && event.Line != "" {
			t.Fatal("failed authentication produced a log line")
		}
	}
}

func TestHostSecurityIntegrityDetectsChanges(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "settings")
	if err := os.WriteFile(target, []byte("first"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "private"), []byte("-----BEGIN OPENSSH PRIVATE KEY-----"), 0600); err != nil {
		t.Fatal(err)
	}
	before := securityIntegrity(context.Background(), []string{dir}, 10, 1024)
	if err := os.WriteFile(target, []byte("second"), 0600); err != nil {
		t.Fatal(err)
	}
	after := securityIntegrity(context.Background(), []string{dir}, 10, 1024)
	if !before.Complete || len(after.Items) != 1 || before.RootHash == after.RootHash || after.Items[0].ID != target {
		t.Fatalf("unexpected integrity result: %+v", after)
	}
	degraded := securitySectionResult(nil, errors.Join(fs.ErrPermission, fs.ErrNotExist))
	if degraded.Status != "not_permitted" || degraded.Complete {
		t.Fatalf("unexpected degraded result: %+v", degraded)
	}
}

func TestHostSecurityIntegritySkipsPrivateMarkerAcrossChunks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fixture")
	const chunk = 32 << 10
	contents := strings.Repeat("a", chunk-5) + "PRIVATE KEY-----"
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	digest, read, err := securityIntegrityHash(context.Background(), path, 2*chunk, make([]byte, chunk))
	if err != nil || digest != "" || read != int64(len(contents)) {
		t.Fatalf("private marker was not excluded: digest=%q bytes=%d err=%v", digest, read, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := securityIntegrityHash(ctx, path, 2*chunk, make([]byte, chunk)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled integrity collection returned %v", err)
	}
}

func BenchmarkHostSecuritySnapshotInventory(b *testing.B) {
	directory := b.TempDir()
	for i := 0; i < 10000; i++ {
		if err := os.WriteFile(filepath.Join(directory, fmt.Sprintf("file-%05d", i)), []byte("sample content"), 0600); err != nil {
			b.Fatal(err)
		}
	}
	line := "ssh-ed25519 " + fixtureSecurityKey() + " fixture"
	var listeners strings.Builder
	for i := 0; i < 200; i++ {
		fmt.Fprintf(&listeners, "tcp LISTEN 0 128 0.0.0.0:%d 0.0.0.0:*\n", 8000+i)
	}
	b.ResetTimer()
	for b.Loop() {
		for k := 0; k < 50; k++ {
			parseSecurityKey(line, "fixture", "/home/fixture/.ssh/authorized_keys")
		}
		if len(securityListeners(listeners.String())) != 200 {
			b.Fatal("listener fixture not parsed")
		}
		section := securityIntegrity(context.Background(), []string{directory}, 10000, 1<<20)
		if !section.Complete || len(section.Items) != 10000 {
			b.Fatalf("incomplete manifest: %d", len(section.Items))
		}
	}
}

func TestHostSecurityListenerOwnerIgnoresInheritingWorkers(t *testing.T) {
	// PIDs have wrapped: the workers have lower PIDs than master.
	parents := map[int]int{997352: 1, 288372: 997352, 285139: 997352}
	previous := processParent
	processParent = func(pid int) (int, bool) { parent, ok := parents[pid]; return parent, ok }
	t.Cleanup(func() { processParent = previous })
	busy := `tcp LISTEN 0 100 0.0.0.0:25 0.0.0.0:* users:(("smtpd",pid=285139,fd=6),("smtpd",pid=288372,fd=6),("master",pid=997352,fd=13))`
	idle := `tcp LISTEN 0 100 0.0.0.0:25 0.0.0.0:* users:(("master",pid=997352,fd=13))`
	for _, raw := range []string{busy, idle} {
		items := securityListeners(raw)
		if len(items) != 1 || items[0].Value.(map[string]any)["process"] != "master" {
			t.Fatalf("listener owner = %+v", items)
		}
	}
	parents[413335] = 1
	for _, raw := range []string{
		`tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=413335,fd=3),("systemd",pid=1,fd=115))`,
		`tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("systemd",pid=1,fd=115),("sshd",pid=413335,fd=3))`,
	} {
		if got := listenerOwner(raw); got != "sshd" {
			t.Fatalf("socket-activated owner = %q", got)
		}
	}
	if got := listenerOwner(`tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("systemd",pid=1,fd=115))`); got != "systemd" {
		t.Fatalf("idle socket-activated owner = %q", got)
	}
	if got := listenerOwner(`tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",fd=3))`); got != "sshd" {
		t.Fatalf("owner without a PID = %q", got)
	}
}

func TestHostSecurityCounters(t *testing.T) {
	windows := map[string]*securityCounterWindow{}
	now := time.Date(2026, 11, 19, 10, 0, 30, 0, time.UTC)
	securityRecordCounter(windows, now, "failed_password", "192.0.2.17")
	securityRecordCounter(windows, now.Add(time.Second), "failed_key", "192.0.2.17")
	securityRecordCounter(windows, now.Add(2*time.Second), "invalid_user", "192.0.2.18")
	securityRecordCounter(windows, now.Add(3*time.Second), "login", "")
	bucket := windows["2026-11-19T10:00:00Z"]
	if bucket.Counter.DistinctFailedSources != 2 || bucket.Counter.Successful != 1 || bucket.Counter.FailedKey != 1 || bucket.Counter.FailedPassword != 1 || bucket.Counter.InvalidUser != 1 {
		t.Fatalf("incorrect counters: %+v", bucket.Counter)
	}
}
