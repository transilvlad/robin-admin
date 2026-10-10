package main

import (
	"slices"
	"strings"
	"testing"
)

func TestPostgresDSNMovesPasswordToEnvironment(t *testing.T) {
	dsn, env := postgresDSNAndEnv("postgresql://robin:s3cr%40t@127.0.0.1:5432/postgres")
	if strings.Contains(dsn, "s3cr") {
		t.Fatalf("password left in DSN: %s", dsn)
	}
	if dsn != "postgresql://robin@127.0.0.1:5432/postgres" {
		t.Fatalf("unexpected DSN: %s", dsn)
	}
	if !slices.Contains(env, "PGPASSWORD=s3cr@t") {
		t.Fatalf("password not passed in PGPASSWORD")
	}
}

func TestPostgresDSNWithoutPasswordIsUnchanged(t *testing.T) {
	for _, input := range []string{"postgresql://robin@localhost/db", "host=/run/postgresql dbname=db"} {
		dsn, _ := postgresDSNAndEnv(input)
		if dsn != input {
			t.Fatalf("DSN changed: %s", dsn)
		}
	}
}

func TestPrivateKeyFiles(t *testing.T) {
	for name, want := range map[string]bool{"dkim/example.com.mail.key": true, "mail.key": true, "dkim_signing.conf": false, "worker-proxy.inc": false} {
		if isPrivateKeyFile(name) != want {
			t.Fatalf("%s: got %v", name, !want)
		}
	}
}
