package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestMariadbCommandLocal(t *testing.T) {
	c := config{mariadbDSN: "mysql://robin_monitor:s3cr%40t@db.internal:3307/app?ssl=true", mariadbClient: "mariadb", execPrefix: map[string]string{}}
	argv, env, err := c.mariadbCommand("db1", "SELECT 1")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"mariadb", "-B", "--force", "--connect-timeout=8", "--protocol=TCP", "-h", "db.internal", "-P", "3307", "-u", "robin_monitor", "--ssl", "--ssl-verify-server-cert", "-e", "SELECT 1"}
	if !slices.Equal(argv, want) {
		t.Fatalf("argv = %q, want %q", argv, want)
	}
	if !slices.Contains(env, "MYSQL_PWD=s3cr@t") {
		t.Fatalf("password not passed in MYSQL_PWD")
	}
	if strings.Contains(strings.Join(argv, " "), "s3cr") {
		t.Fatalf("password leaked onto argv: %q", argv)
	}
}

func TestMariadbCommandInContainerForwardsPasswordByName(t *testing.T) {
	c := config{
		mariadbDSN: "mariadb://robin_monitor:pw@127.0.0.1:3306/",
		execPrefix: map[string]string{"app-db": "docker exec app-database"},
	}
	argv, env, err := c.mariadbCommand("app-db", "SELECT 1")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"docker", "exec", "-e", "MYSQL_PWD", "app-database", "mariadb", "-B"}; !slices.Equal(argv[:7], want) {
		t.Fatalf("argv = %q", argv)
	}
	if !slices.Contains(env, "MYSQL_PWD=pw") || slices.Contains(argv, "pw") {
		t.Fatalf("password must be in the env only: argv=%q", argv)
	}
}

func TestMariadbCommandSocketAndPerServiceDSN(t *testing.T) {
	t.Setenv("ROBIN_AGENT_MARIADB_DSN_APP_DB_2", "mysql://monitor@localhost/?socket=/run/mysqld/mysqld.sock")
	c := config{mariadbDSN: "mysql://other@elsewhere/", mariadbClient: "mysql", execPrefix: map[string]string{}}
	argv, env, err := c.mariadbCommand("app-db-2", "SELECT 1")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"mysql", "-B", "--force", "--connect-timeout=8", "--protocol=SOCKET", "--socket=/run/mysqld/mysqld.sock", "-u", "monitor", "-e", "SELECT 1"}; !slices.Equal(argv, want) {
		t.Fatalf("argv = %q, want %q", argv, want)
	}
	if env != nil {
		t.Fatalf("no password, so the environment is inherited unchanged")
	}
}

func TestMariadbCommandRejectsMissingOrForeignDSN(t *testing.T) {
	if _, _, err := (config{}).mariadbCommand("db1", "SELECT 1"); err == nil {
		t.Fatal("expected an error without a DSN")
	}
	if _, _, err := (config{mariadbDSN: "postgresql://db/x"}).mariadbCommand("db1", "SELECT 1"); err == nil {
		t.Fatal("expected an error for a non-MariaDB DSN")
	}
}

func TestMariadbCommandTLSModes(t *testing.T) {
	for _, tc := range []struct{ client, mode, flag string }{
		{"mysql", "true", "--ssl-mode=VERIFY_IDENTITY"},
		{"mysql", "required", "--ssl-mode=VERIFY_IDENTITY"},
		{"mysql", "skip-verify", "--ssl-mode=REQUIRED"},
		{"mysql", "false", "--ssl-mode=DISABLED"},
		{"mariadb", "required", "--ssl-verify-server-cert"},
		{"mariadb", "skip-verify", "--skip-ssl-verify-server-cert"},
		{"mariadb", "false", "--skip-ssl"},
	} {
		t.Run(tc.client+"/"+tc.mode, func(t *testing.T) {
			c := config{mariadbDSN: "mysql://monitor@localhost:3307/?ssl=" + tc.mode, mariadbClient: tc.client}
			argv, _, err := c.mariadbCommand("db", "SELECT 1")
			if err != nil || !slices.Contains(argv, tc.flag) || !slices.Contains(argv, "--protocol=TCP") {
				t.Fatalf("argv=%q err=%v", argv, err)
			}
		})
	}
	for _, option := range []string{"ssl=invalid", "host=other"} {
		if _, _, err := (config{mariadbDSN: "mysql://localhost/?" + option}).mariadbCommand("db", "SELECT 1"); err == nil {
			t.Fatalf("accepted invalid option %s", option)
		}
	}
}

func TestMariadbSizeCadence(t *testing.T) {
	now := time.Now()
	if !mariadbSizeDue("cadence", now) {
		t.Fatal("size is due before it was ever collected")
	}
	markMariadbSize("cadence", now)
	if mariadbSizeDue("cadence", now.Add(time.Minute)) {
		t.Fatal("size is not due a minute after a collection")
	}
	if !mariadbSizeDue("cadence", now.Add(mariadbSizeInterval)) {
		t.Fatal("size is due again after the interval")
	}
}

// A stand-in client: prints a batch like `mariadb -B --force` and fails like
// --force does after a section it could not read.
func fakeMariadbClient(t *testing.T, script string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs a POSIX shell")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-mariadb")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCollectMariadb(t *testing.T) {
	client := fakeMariadbClient(t, `[ "$MYSQL_PWD" = pw ] || { echo "Access denied" >&2; exit 1; }
case "$*" in *"##size"*) size=1 ;; esac
printf '##status\n##status\nVariable_name\tValue\nUptime\t10\n##replica\n##replica\n'
[ -n "$size" ] && printf '##size\n##size\nk\tv\ndatabase_size_bytes\t5\n'
echo "ERROR 1227: Access denied; you need the REPLICA MONITOR privilege" >&2
exit 1
`)
	c := config{mariadbDSN: "mysql://m:pw@127.0.0.1/", mariadbClient: client, execPrefix: map[string]string{}}
	now := time.Now()
	snapshot, code := collectMariadb(context.Background(), c, "collect-1", now)
	if code != "" || !strings.Contains(snapshot, "Uptime\t10") || !strings.Contains(snapshot, "database_size_bytes\t5") {
		t.Fatalf("partial batch must still ship: code=%q snapshot=%q", code, snapshot)
	}
	snapshot, _ = collectMariadb(context.Background(), c, "collect-1", now.Add(time.Minute))
	if strings.Contains(snapshot, "##size") {
		t.Fatal("size is skipped until the interval passes")
	}

	c.mariadbDSN = "mysql://m:wrong@127.0.0.1/"
	if _, code := collectMariadb(context.Background(), c, "collect-2", now); code != "collection_failed" {
		t.Fatalf("no status section means the collection failed, got %q", code)
	}
	c.mariadbClient = filepath.Join(t.TempDir(), "missing")
	if _, code := collectMariadb(context.Background(), c, "collect-3", now); code != "collector_unavailable" {
		t.Fatalf("a missing client is collector_unavailable, got %q", code)
	}
}

func TestCollectMariadbCancellationAndOutputLimit(t *testing.T) {
	client := fakeMariadbClient(t, "printf '##status\\nVariable_name\\tValue\\nUptime\\t10\\n'\nhead -c 5242880 /dev/zero\n")
	c := config{mariadbDSN: "mysql://monitor@localhost/", mariadbClient: client}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if snapshot, code := collectMariadb(ctx, c, "cancelled", time.Now()); snapshot != "" || code != "collection_failed" {
		t.Fatalf("cancelled collector returned %q %q", snapshot, code)
	}
	if snapshot, code := collectMariadb(context.Background(), c, "overflow", time.Now()); snapshot != "" || code != "collection_failed" {
		t.Fatalf("oversized output returned %d bytes %q", len(snapshot), code)
	}
}

func TestMariadbLogSourceDefault(t *testing.T) {
	src, ok := resolveLogSource("mariadb", "app-db")
	if !ok || src.unit != "mariadb" || src.file != "/var/log/mysql/error.log" {
		t.Fatalf("mariadb log source = %+v", src)
	}
}
