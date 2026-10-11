package main

import (
	"log"
	"net/url"
	"os"
	"os/user"
	"strconv"
	"strings"
)

// isPrivateKeyFile reports whether a managed file holds a private key (Rspamd
// DKIM keys), which must not be world-readable.
func isPrivateKeyFile(rel string) bool {
	return strings.HasSuffix(rel, ".key") || strings.HasPrefix(rel, "dkim/")
}

// restrictPrivateKey makes a written key readable by root and the Rspamd group
// only. When neither _rspamd nor rspamd exists on this host the file keeps its
// mode, so signing never breaks because the key became unreadable.
func restrictPrivateKey(path string) {
	for _, name := range []string{"_rspamd", "rspamd"} {
		group, err := user.LookupGroup(name)
		if err != nil {
			continue
		}
		gid, err := strconv.Atoi(group.Gid)
		if err != nil {
			continue
		}
		if err := os.Chown(path, -1, gid); err != nil {
			log.Printf("robin-agent: could not set the group of %s: %v", path, err)
			return
		}
		if err := os.Chmod(path, 0o640); err != nil {
			log.Printf("robin-agent: could not restrict %s: %v", path, err)
		}
		return
	}
}

// postgresDSNAndEnv moves a password out of a postgres:// DSN into PGPASSWORD,
// so it does not appear on the psql command line (visible in ps and /proc).
// Other DSN forms are returned unchanged.
func postgresDSNAndEnv(dsn string) (string, []string) {
	parsed, err := url.Parse(dsn)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.User == nil {
		return dsn, os.Environ()
	}
	password, ok := parsed.User.Password()
	if !ok {
		return dsn, os.Environ()
	}
	parsed.User = url.User(parsed.User.Username())
	return parsed.String(), append(os.Environ(), "PGPASSWORD="+password)
}
