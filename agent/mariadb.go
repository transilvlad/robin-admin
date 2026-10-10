package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// MariaDB (and MySQL) is collected by running the statistics batch through the
// service's own client and shipping the batch output; robin-admin parses it
// (buildMariadbSnapshotFromRaw). server/src/services/mariadb.ts builds the same
// text for direct mode, and a server test keeps the two identical.
const mariadbSnapshotSQL = `/*M!100100 SET SESSION max_statement_time = 16 */;
SELECT '##status';
SHOW GLOBAL STATUS;
SELECT '##variables';
SHOW GLOBAL VARIABLES WHERE Variable_name IN ('version', 'version_comment', 'max_connections', 'wait_timeout', 'interactive_timeout', 'max_statement_time', 'max_execution_time', 'innodb_lock_wait_timeout', 'lock_wait_timeout', 'slow_query_log', 'long_query_time', 'log_queries_not_using_indexes', 'innodb_print_all_deadlocks', 'innodb_io_capacity', 'innodb_io_capacity_max', 'innodb_flush_log_at_trx_commit', 'sync_binlog', 'tmp_table_size', 'max_heap_table_size', 'table_open_cache', 'thread_cache_size', 'innodb_buffer_pool_size', 'innodb_log_file_size', 'innodb_buffer_pool_instances', 'innodb_read_io_threads', 'innodb_write_io_threads', 'performance_schema');
SELECT '##trx';
SELECT 'trx_active' AS k, COUNT(*) AS v FROM information_schema.INNODB_TRX UNION ALL SELECT 'oldest_trx_age_secs', COALESCE(MAX(TIMESTAMPDIFF(SECOND, trx_started, NOW())), 0) FROM information_schema.INNODB_TRX UNION ALL SELECT 'trx_lock_waits', COUNT(*) FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT' UNION ALL SELECT 'schema_count', COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') UNION ALL SELECT LOWER(m.NAME), m.COUNT FROM information_schema.INNODB_METRICS m WHERE m.NAME IN ('lock_deadlocks', 'trx_rseg_history_len');
SELECT '##replica';
SHOW REPLICA STATUS;`

// mariadbSizeSQL is appended every mariadbSizeInterval: summing table sizes
// opens table metadata and can be expensive across many schemas.
const mariadbSizeSQL = `
SELECT '##size';
SELECT 'database_size_bytes' AS k, COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS v FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys');`

const (
	mariadbSizeInterval = 10 * time.Minute
)

var (
	mariadbSizeMu sync.Mutex
	mariadbSizeAt = map[string]time.Time{}
)

func mariadbSizeDue(serviceID string, now time.Time) bool {
	mariadbSizeMu.Lock()
	defer mariadbSizeMu.Unlock()
	return now.Sub(mariadbSizeAt[serviceID]) >= mariadbSizeInterval
}

func markMariadbSize(serviceID string, at time.Time) {
	mariadbSizeMu.Lock()
	defer mariadbSizeMu.Unlock()
	mariadbSizeAt[serviceID] = at
}

// mariadbDSNFor is the service's own DSN (ROBIN_AGENT_MARIADB_DSN_<SERVICE_ID>,
// for an agent watching several instances), else the agent-wide one.
func (c config) mariadbDSNFor(serviceID string) string {
	if dsn := strings.TrimSpace(os.Getenv("ROBIN_AGENT_MARIADB_DSN_" + envKey(serviceID))); dsn != "" {
		return dsn
	}
	return c.mariadbDSN
}

// mariadbCommand is the client invocation for one service: argv (through the
// service's exec prefix, e.g. `docker exec app-database`) and the process
// environment. The password travels only in MYSQL_PWD, which `docker exec -e
// MYSQL_PWD` forwards by name, so it never appears on a command line.
func (c config) mariadbCommand(serviceID, sql string) ([]string, []string, error) {
	dsn := c.mariadbDSNFor(serviceID)
	if dsn == "" {
		return nil, nil, fmt.Errorf("no ROBIN_AGENT_MARIADB_DSN for %s", serviceID)
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "mysql" && u.Scheme != "mariadb") {
		return nil, nil, fmt.Errorf("ROBIN_AGENT_MARIADB_DSN must be a mysql:// or mariadb:// URL")
	}
	client := c.mariadbClient
	if client == "" {
		client = "mariadb"
		if c.execPrefix[serviceID] == "" {
			if _, err := exec.LookPath("mariadb"); err != nil {
				if _, err := exec.LookPath("mysql"); err == nil {
					client = "mysql"
				}
			}
		}
	}
	args := []string{"-B", "--force", "--connect-timeout=8"}
	query := u.Query()
	for key := range query {
		if key != "socket" && key != "ssl" {
			return nil, nil, fmt.Errorf("unsupported MariaDB connection option")
		}
	}
	if socket := query.Get("socket"); socket != "" {
		args = append(args, "--protocol=SOCKET", "--socket="+socket)
	} else {
		host := u.Hostname()
		if host == "" {
			host = "127.0.0.1"
		}
		args = append(args, "--protocol=TCP", "-h", host)
		if port := u.Port(); port != "" {
			args = append(args, "-P", port)
		}
	}
	if user := u.User.Username(); user != "" {
		args = append(args, "-u", user)
	}
	switch strings.ToLower(query.Get("ssl")) {
	case "true", "required":
		if filepath.Base(client) == "mysql" {
			args = append(args, "--ssl-mode=VERIFY_IDENTITY")
		} else {
			args = append(args, "--ssl", "--ssl-verify-server-cert")
		}
	case "skip-verify":
		if filepath.Base(client) == "mysql" {
			args = append(args, "--ssl-mode=REQUIRED")
		} else {
			args = append(args, "--ssl", "--skip-ssl-verify-server-cert")
		}
	case "false":
		if filepath.Base(client) == "mysql" {
			args = append(args, "--ssl-mode=DISABLED")
		} else {
			args = append(args, "--skip-ssl")
		}
	case "":
	default:
		return nil, nil, fmt.Errorf("unsupported MariaDB TLS mode")
	}
	args = append(args, "-e", sql)
	argv := c.execArgv(serviceID, append([]string{client}, args...))
	if password, ok := u.User.Password(); ok {
		return forwardEnvByName(argv, "MYSQL_PWD"), append(os.Environ(), "MYSQL_PWD="+password), nil
	}
	return argv, nil, nil
}

// forwardEnvByName makes `docker|podman exec` pass one variable from the
// agent's own environment into the container (`-e NAME`, no value on argv).
func forwardEnvByName(argv []string, name string) []string {
	if len(argv) < 2 || argv[1] != "exec" {
		return argv
	}
	if tool := filepath.Base(argv[0]); tool != "docker" && tool != "podman" {
		return argv
	}
	out := append([]string{argv[0], argv[1], "-e", name}, argv[2:]...)
	return out
}

// collectMariadb runs the batch for one service. --force carries on past a
// section the monitoring user can't read (no PROCESS grant, not a replica), so
// the status section alone decides whether the server answered.
func collectMariadb(ctx context.Context, c config, serviceID string, now time.Time) (string, string) {
	sql := mariadbSnapshotSQL
	withSize := mariadbSizeDue(serviceID, now)
	if withSize {
		sql += mariadbSizeSQL
	}
	argv, env, err := c.mariadbCommand(serviceID, sql)
	if err != nil {
		log.Printf("robin-agent: mariadb collect for %s: %v", serviceID, err)
		return "", "collector_unavailable"
	}
	if _, err := exec.LookPath(argv[0]); err != nil {
		return "", "collector_unavailable"
	}
	out, runErr := captureProcessWithEnv(ctx, argv, true, env)
	snapshot := string(out)
	if !strings.Contains(snapshot, "##status\n") || !strings.Contains(snapshot, "Variable_name\tValue") {
		log.Printf("robin-agent: mariadb collect for %s failed: %v", serviceID, runErr)
		return "", "collection_failed"
	}
	if runErr != nil {
		log.Printf("robin-agent: mariadb collect for %s was partial: %v", serviceID, runErr)
	}
	if withSize && strings.Contains(snapshot, "database_size_bytes\t") {
		markMariadbSize(serviceID, now)
	}
	return snapshot, ""
}
