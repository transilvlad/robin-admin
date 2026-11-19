package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
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
