// robin-agent is the unified fleet agent for robin-admin.
//
// It runs on a mail-server host or container (or a combination of co-located
// applications) and dials OUT to robin-admin — so it works behind NAT and
// firewalls and inside containers, with only outbound egress. robin-admin never
// initiates a connection to the host.
//
// It enrolls once with a one-time token (or a pre-provisioned credential), then
// heartbeats, applies rendered config, ships metrics and new log lines, and runs
// allowlisted operational commands (commands.go) — all over the same outbound
// channel. The agent stays a thin executor: it runs commands and ships raw
// output, writes files robin-admin renders, and tails logs; robin-admin keeps
// all rendering/parsing.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// agentVersion is overridden at build time via -ldflags "-X main.agentVersion=<v>".
var agentVersion = "0.1.0-dev"

type config struct {
	adminURL        string
	agentID         string
	enrollmentToken string
	credential      string
	statePath       string
	insecureTLS     bool
	probes          []probe
	managedRoot     string
	applyOnly       bool
	redisAddr       string
	clamavAddr      string
	rspamdURL       string
	rspamdPassword  string
	robinMetricsURL string
	postgresDSN     string
	mariadbDSN      string
	mariadbClient   string
	execPrefix      map[string]string
}

type probe struct {
	serviceType string
	addr        string
}

type discoveredService struct {
	ServiceType string `json:"serviceType"`
	Detail      string `json:"detail,omitempty"`
	Source      string `json:"source,omitempty"`
}

type state struct {
	AgentID     string            `json:"agentId"`
	Credential  string            `json:"credential"`
	LastApplied map[string]string `json:"lastApplied,omitempty"`
	// AppliedFiles lists each service's managed files, so files dropped from
	// its manifest can be deleted.
	AppliedFiles map[string][]string `json:"appliedFiles,omitempty"`
}

func loadConfig() (config, error) {
	c := config{
		adminURL:        strings.TrimRight(os.Getenv("ROBIN_ADMIN_URL"), "/"),
		agentID:         os.Getenv("ROBIN_AGENT_ID"),
		enrollmentToken: os.Getenv("ROBIN_ENROLLMENT_TOKEN"),
		credential:      os.Getenv("ROBIN_AGENT_CREDENTIAL"),
		statePath:       os.Getenv("ROBIN_AGENT_STATE"),
		insecureTLS:     os.Getenv("ROBIN_AGENT_INSECURE") == "1" || os.Getenv("ROBIN_AGENT_INSECURE") == "true",
	}
	if c.adminURL == "" {
		return c, fmt.Errorf("ROBIN_ADMIN_URL is required (e.g. http://robin-admin-server:3001)")
	}
	if c.statePath == "" {
		c.statePath = "/var/lib/robin-agent/state.json"
	}
	// ROBIN_AGENT_PROBE: comma-separated type=host:port entries, e.g.
	// "postfix=postfix:25,dovecot=dovecot:143,rspamd=spam-backend:11334".
	for _, entry := range strings.Split(os.Getenv("ROBIN_AGENT_PROBE"), ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		kind, addr, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		c.probes = append(c.probes, probe{serviceType: strings.TrimSpace(kind), addr: strings.TrimSpace(addr)})
	}
	c.managedRoot = os.Getenv("ROBIN_AGENT_MANAGED_ROOT")
	if c.managedRoot == "" {
		c.managedRoot = "/"
	}
	// Deliver rendered config to disk but skip the validate+reload step — for
	// hosts where a separate mechanism reloads the service, or for dev where
	// the service tooling isn't present.
	c.applyOnly = os.Getenv("ROBIN_AGENT_APPLY_ONLY") == "1" || os.Getenv("ROBIN_AGENT_APPLY_ONLY") == "true"
	c.redisAddr = os.Getenv("ROBIN_AGENT_REDIS_ADDR")
	if c.redisAddr == "" {
		c.redisAddr = "127.0.0.1:6379"
	}
	c.clamavAddr = os.Getenv("ROBIN_AGENT_CLAMAV_ADDR")
	if c.clamavAddr == "" {
		c.clamavAddr = "127.0.0.1:3310"
	}
	c.rspamdURL = strings.TrimRight(os.Getenv("ROBIN_AGENT_RSPAMD_URL"), "/")
	if c.rspamdURL == "" {
		c.rspamdURL = "http://127.0.0.1:11334"
	}
	c.rspamdPassword = os.Getenv("ROBIN_AGENT_RSPAMD_PASSWORD")
	c.robinMetricsURL = strings.TrimRight(os.Getenv("ROBIN_AGENT_ROBIN_METRICS_URL"), "/")
	if c.robinMetricsURL == "" {
		c.robinMetricsURL = "http://127.0.0.1:8080"
	}
	c.postgresDSN = os.Getenv("ROBIN_AGENT_POSTGRES_DSN")
	c.mariadbDSN = strings.TrimSpace(os.Getenv("ROBIN_AGENT_MARIADB_DSN"))
	c.mariadbClient = strings.TrimSpace(os.Getenv("ROBIN_AGENT_MARIADB_CLIENT"))
	// ROBIN_AGENT_EXEC_PREFIX: comma-separated serviceId=prefix entries whose
	// prefix is prepended to a service's exec-based collect/validate/reload
	// commands, so the agent can reach a service that is NOT a local host binary.
	// The service's own tool stays the command; the prefix says how to run it:
	//   host package  → (no entry): `doveadm stats dump`
	//   container     → suite-dovecot=docker exec suite-dovecot
	//   remote host   → mail1=ssh mail1
	// yielding e.g. `docker exec suite-dovecot doveadm stats dump`. This keeps
	// every service integration deployment-agnostic — robin-admin can manage an
	// arbitrary install of the service, not just a co-located one.
	c.execPrefix = map[string]string{}
	for _, entry := range strings.Split(os.Getenv("ROBIN_AGENT_EXEC_PREFIX"), ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		id, prefix, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		id, prefix = strings.TrimSpace(id), strings.TrimSpace(prefix)
		if id != "" && prefix != "" {
			c.execPrefix[id] = prefix
		}
	}
	return c, nil
}

// execArgv prepends any configured exec-prefix for this service so the agent can
// run the service's own tool wherever the service lives — locally (no prefix, a
// host package), inside a container (`docker exec <name>`), or on another host
// (`ssh <host>`). With no prefix it returns argv unchanged, so behaviour is
// byte-identical for co-located installs.
func (c config) execArgv(serviceID string, argv []string) []string {
	prefix := c.execPrefix[serviceID]
	if prefix == "" {
		return argv
	}
	full := strings.Fields(prefix)
	if isSSHPrefix(prefix) {
		// ssh hands the words to the remote login shell as one string, so each
		// argument is quoted to reach the command intact.
		for _, arg := range argv {
			full = append(full, shellQuote(arg))
		}
		return full
	}
	return append(full, argv...)
}

// isSSHPrefix reports whether an exec prefix runs commands on another host
// over ssh, where the agent can run commands but cannot place files.
func isSSHPrefix(prefix string) bool {
	fields := strings.Fields(prefix)
	return len(fields) > 0 && filepath.Base(fields[0]) == "ssh"
}

func shellQuote(arg string) string {
	if arg != "" && strings.IndexFunc(arg, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_./=:,@%+", r))
	}) < 0 {
		return arg
	}
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

// managedRelPath is a manifest file name as a path under the recipe's
// directory: subdirectories (rspamd's maps/) are kept, anything that would
// leave the directory is refused.
func managedRelPath(name string) (string, bool) {
	clean := path.Clean(strings.ReplaceAll(name, "\\", "/"))
	if clean == "." || path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return clean, true
}

// postgresSnapshotSQL is one consolidated query returning a single JSON object
// with the core Postgres metrics. The agent runs it via psql and ships the JSON;
// robin-admin parses it (buildPostgresSnapshotFromRaw). Kept to primary-safe
// catalog reads so it works on a replica too.
const postgresSnapshotSQL = `SELECT json_build_object('versionNum',current_setting('server_version_num'),'maxConnections',current_setting('max_connections'),'dbSize',pg_database_size(current_database()),'db',(SELECT row_to_json(t) FROM (SELECT SUM(xact_commit) xact_commit,SUM(xact_rollback) xact_rollback,SUM(blks_hit) blks_hit,SUM(blks_read) blks_read,SUM(tup_returned) tup_returned,SUM(tup_fetched) tup_fetched,SUM(tup_inserted) tup_inserted,SUM(tup_updated) tup_updated,SUM(tup_deleted) tup_deleted,SUM(deadlocks) deadlocks,SUM(temp_files) temp_files,SUM(temp_bytes) temp_bytes,SUM(conflicts) conflicts FROM pg_stat_database WHERE datname IS NOT NULL) t),'activity',(SELECT COALESCE(json_agg(json_build_object('state',state,'wait_event_type',wait_event_type,'xact_start',xact_start,'state_change',state_change)),'[]'::json) FROM pg_stat_activity WHERE pid <> pg_backend_pid()),'deadTuples',(SELECT COALESCE(SUM(n_dead_tup),0) FROM pg_stat_user_tables))`

// httpGetText fetches a URL and returns the response body as text (for shipping
// endpoint output — Rspamd /metrics + /stat, Robin /metrics/prometheus — to
// robin-admin, which parses it). Non-2xx is an error so partial data isn't shipped.
func httpGetText(client *http.Client, url string, headers map[string]string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return string(body), nil
}

// clamdCommand runs a single clamd command over TCP (the `n`-prefixed,
// newline-terminated protocol) and returns the raw reply for robin-admin to
// parse. clamd closes the connection after a one-shot command's reply.
func clamdCommand(addr, cmd string) (string, error) {
	conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("n" + cmd + "\n")); err != nil {
		return "", err
	}
	out, err := io.ReadAll(conn)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// redisInfo runs the Redis INFO command over RESP (no redis-cli dependency) and
// returns the raw reply for robin-admin to parse.
func redisInfo(addr string) (string, error) {
	conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("INFO\r\n")); err != nil {
		return "", err
	}
	r := bufio.NewReader(conn)
	header, err := r.ReadString('\n')
	if err != nil {
		return "", err
	}
	header = strings.TrimRight(header, "\r\n")
	if len(header) == 0 || header[0] != '$' {
		return "", fmt.Errorf("unexpected INFO reply: %q", header)
	}
	n, err := strconv.Atoi(header[1:])
	if err != nil || n < 0 {
		return "", fmt.Errorf("bad bulk length: %q", header)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", err
	}
	return string(buf), nil
}

func newHTTPClient(insecure bool) *http.Client {
	transport := &http.Transport{}
	if insecure {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // dev/self-signed suites
	}
	return &http.Client{Timeout: 15 * time.Second, Transport: transport}
}

func loadState(path string) (state, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return state{}, false
	}
	var s state
	if err := json.Unmarshal(data, &s); err != nil || s.AgentID == "" || s.Credential == "" {
		return state{}, false
	}
	return s, true
}

func saveState(path string, s state) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return h
}

// discover TCP-dials each configured probe; reachable targets are reported as
// discovered services. This is the thin, dependency-free Phase-1 discovery;
// richer detection (systemd units, config files) lands with later phases.
func discover(probes []probe) []discoveredService {
	out := make([]discoveredService, 0, len(probes))
	for _, p := range probes {
		conn, err := net.DialTimeout("tcp", p.addr, 2*time.Second)
		if err != nil {
			continue
		}
		_ = conn.Close()
		out = append(out, discoveredService{ServiceType: p.serviceType, Detail: p.addr, Source: "tcp-probe"})
	}
	return out
}

func postJSON(client *http.Client, url string, headers map[string]string, body any, out any) (int, error) {
	return postJSONContext(context.Background(), client, url, headers, body, out)
}

func postJSONContext(ctx context.Context, client *http.Client, url string, headers map[string]string, body any, out any) (int, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		_ = json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode, nil
}

type apiEnvelope struct {
	Success bool            `json:"success"`
	Error   string          `json:"error"`
	Data    json.RawMessage `json:"data"`
}

func enroll(client *http.Client, c config) (state, error) {
	if c.agentID == "" || c.enrollmentToken == "" {
		return state{}, fmt.Errorf("no stored credential and no ROBIN_AGENT_ID/ROBIN_ENROLLMENT_TOKEN to enroll with — create an agent in robin-admin and set them")
	}
	body := map[string]any{
		"agentId":         c.agentID,
		"enrollmentToken": c.enrollmentToken,
		"hostname":        hostname(),
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
		"agentVersion":    agentVersion,
		"discovered":      discover(c.probes),
	}
	var env apiEnvelope
	code, err := postJSON(client, c.adminURL+"/api/fleet/agent/enroll", nil, body, &env)
	if err != nil {
		return state{}, err
	}
	if code < 200 || code >= 300 || !env.Success {
		return state{}, fmt.Errorf("enroll failed (HTTP %d): %s", code, env.Error)
	}
	var data struct {
		AgentID    string `json:"agentId"`
		Credential string `json:"credential"`
	}
	if err := json.Unmarshal(env.Data, &data); err != nil {
		return state{}, err
	}
	if data.Credential == "" {
		return state{}, fmt.Errorf("enroll succeeded but no credential returned")
	}
	return state{AgentID: data.AgentID, Credential: data.Credential}, nil
}

func heartbeat(client *http.Client, c config, s state, reports map[string]serviceReport) (bool, error) {
	body := map[string]any{
		"services":             reports,
		"agentId":              s.AgentID,
		"agentVersion":         agentVersion,
		"clientTime":           time.Now().UTC().Format(time.RFC3339Nano),
		"probeProtocolVersion": 1,
		"hostname":             hostname(),
		"os":                   runtime.GOOS,
		"arch":                 runtime.GOARCH,
		"discovered":           discover(c.probes),
	}
	headers := map[string]string{
		"Authorization":    "Bearer " + s.Credential,
		"X-Robin-Agent-Id": s.AgentID,
	}
	var env apiEnvelope
	code, err := postJSON(client, c.adminURL+"/api/fleet/agent/heartbeat", headers, body, &env)
	if err != nil {
		return false, err
	}
	if code == http.StatusUnauthorized {
		return false, fmt.Errorf("credential rejected (HTTP 401) — re-enrollment required")
	}
	if code < 200 || code >= 300 || !env.Success {
		return false, fmt.Errorf("heartbeat failed (HTTP %d): %s", code, env.Error)
	}
	var data struct {
		ProbeEnabled bool `json:"probeEnabled"`
	}
	if err := json.Unmarshal(env.Data, &data); err != nil {
		return false, fmt.Errorf("heartbeat response was invalid: %w", err)
	}
	return data.ProbeEnabled, nil
}

// ── Config apply (Phase 2) ──────────────────────────────────────────────────
// The agent is a thin executor: robin-admin renders the config; the agent pulls
// the manifest + files for services it owns, writes the rendered text files to
// the service's config directory, then validates + reloads. It never renders.

type ownedService struct {
	ServiceID   string `json:"serviceId"`
	ServiceType string `json:"serviceType"`
	Name        string `json:"name"`
	Enabled     bool   `json:"enabled"`
	// Per-axis responsibilities set by robin-admin. A metrics agent does all
	// three; a logs-only log agent does logs alone (metrics stay direct).
	CollectMetrics bool `json:"collectMetrics"`
	CollectConfig  bool `json:"collectConfig"`
	CollectLogs    bool `json:"collectLogs"`
}

type manifestFile struct {
	FileName    string `json:"fileName"`
	PayloadKind string `json:"payloadKind"`
	Sha256      string `json:"sha256"`
}

type serviceManifest struct {
	ServiceID   string         `json:"serviceId"`
	ServiceType string         `json:"serviceType"`
	Sha256      string         `json:"sha256"`
	Files       []manifestFile `json:"files"`
}

type configFile struct {
	FileName    string          `json:"fileName"`
	PayloadKind string          `json:"payloadKind"`
	Payload     json.RawMessage `json:"payload"`
	Sha256      string          `json:"sha256"`
}

// Per-service-type apply recipe: where rendered text files land, and how to
// validate + reload. Directories are prefixed with ROBIN_AGENT_MANAGED_ROOT.
type applyRecipe struct {
	targetDir string
	// postconf: Postfix has no include directive, so the `key = value` lines of
	// each rendered *.cf file are applied to main.cf with `postconf -e`.
	postconf bool
	validate [][]string
	reload   [][]string
}

var applyRecipes = map[string]applyRecipe{
	"dovecot": {targetDir: "/etc/dovecot/conf.d", validate: [][]string{{"doveconf", "-n"}}, reload: [][]string{{"doveadm", "reload"}}},
	"rspamd":  {targetDir: "/etc/rspamd/local.d", validate: [][]string{{"rspamadm", "configtest"}}, reload: [][]string{{"rspamadm", "control", "reload"}}},
	"postfix": {targetDir: "/etc/postfix", postconf: true, validate: [][]string{{"postfix", "check"}}, reload: [][]string{{"postfix", "reload"}}},
	"clamav":  {targetDir: "/etc/clamav"},
	"robin":   {targetDir: "/usr/local/robin/cfg"},
}

func agentGet(ctx context.Context, client *http.Client, url string, s state, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+s.Credential)
	req.Header.Set("X-Robin-Agent-Id", s.AgentID)
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		_ = json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode, nil
}

// applyResult is one config apply: the manifest sha, a status of ""
// (unchanged), "succeeded", or "failed" with a human message, and how many
// files were written.
type applyResult struct {
	manifestSha string
	status      string
	message     string
	files       int
	applied     []string // the managed file names now in place
}

func applyService(parent context.Context, client *http.Client, c config, s state, svc ownedService) applyResult {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	base := c.adminURL + "/api/fleet/agent/services/" + url.PathEscape(svc.ServiceID)

	var menv apiEnvelope
	code, err := agentGet(ctx, client, base+"/manifest", s, &menv)
	if err != nil || code < 200 || code >= 300 || !menv.Success {
		return applyResult{status: "failed", message: fmt.Sprintf("manifest fetch failed (HTTP %d)", code)}
	}
	var man serviceManifest
	if err := json.Unmarshal(menv.Data, &man); err != nil {
		return applyResult{status: "failed", message: "manifest decode failed"}
	}
	if man.Sha256 != "" && s.LastApplied[svc.ServiceID] == man.Sha256 {
		return applyResult{manifestSha: man.Sha256} // already applied
	}

	recipe, ok := applyRecipes[man.ServiceType]
	if !ok {
		// No file-based apply recipe for this type — e.g. redis/postgres apply
		// config over their own protocol via robin-admin (direct mode), not by
		// dropping files. Skip config apply rather than reporting a failure.
		return applyResult{manifestSha: man.Sha256}
	}

	// Over ssh the agent can run commands on the service's host but has no way
	// to put files there; refuse rather than report files it never delivered.
	if isSSHPrefix(c.execPrefix[svc.ServiceID]) && !c.applyOnly {
		return applyResult{manifestSha: man.Sha256, status: "failed", message: "config files cannot be delivered over ssh; run the agent on the service's host or next to its container"}
	}

	// A service reached with `docker exec` reads its config from the
	// container's filesystem, not the agent's, so each file is also copied in.
	// Apply-only (staging) mode leaves the container alone.
	cli, container := containerExecTarget(c.execPrefix[svc.ServiceID])
	copyIn := container != "" && !c.applyOnly
	readyDirs := map[string]bool{}
	tx := &applyTx{cli: cli, container: container, execArgv: func(argv []string) []string { return c.execArgv(svc.ServiceID, argv) }}
	failed := func(message string) applyResult {
		if note := tx.rollback(); note != "" {
			message += "; " + note
		}
		return applyResult{manifestSha: man.Sha256, status: "failed", message: message}
	}

	// Fetch every file before changing anything on disk.
	type managedFile struct{ rel, content string }
	var files []managedFile
	for _, f := range man.Files {
		if err := ctx.Err(); err != nil {
			return applyResult{manifestSha: man.Sha256, status: "failed", message: err.Error()}
		}
		if f.PayloadKind != "text" {
			continue // JSON payloads are managed-values metadata, not written to disk
		}
		var fenv apiEnvelope
		code, err := agentGet(ctx, client, base+"/files/"+url.PathEscape(f.FileName), s, &fenv)
		if err != nil || code < 200 || code >= 300 || !fenv.Success {
			return applyResult{manifestSha: man.Sha256, status: "failed", message: fmt.Sprintf("file %s fetch failed (HTTP %d)", f.FileName, code)}
		}
		var cf configFile
		if err := json.Unmarshal(fenv.Data, &cf); err != nil {
			return applyResult{manifestSha: man.Sha256, status: "failed", message: "file decode failed: " + f.FileName}
		}
		var content string
		if err := json.Unmarshal(cf.Payload, &content); err != nil {
			continue // not a string payload; skip defensively
		}
		rel, ok := managedRelPath(f.FileName)
		if !ok {
			return applyResult{manifestSha: man.Sha256, status: "failed", message: "refusing file outside the config directory: " + f.FileName}
		}
		files = append(files, managedFile{rel: rel, content: content})
	}

	written := 0
	applied := make([]string, 0, len(files))
	current := map[string]bool{}
	var postconfArgs []string
	for _, f := range files {
		if err := ctx.Err(); err != nil {
			return failed(err.Error())
		}
		target := filepath.Join(c.managedRoot, recipe.targetDir, filepath.FromSlash(f.rel))
		destPath := ""
		if copyIn {
			destPath = path.Join(recipe.targetDir, f.rel)
		}
		if err := tx.backup(target, destPath); err != nil {
			return failed("backup failed: " + err.Error())
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return failed("mkdir failed: " + err.Error())
		}
		if err := os.WriteFile(target, []byte(f.content), 0o644); err != nil {
			return failed("write failed: " + err.Error())
		}
		if !copyIn && isPrivateKeyFile(f.rel) {
			restrictPrivateKey(target)
		}
		if copyIn {
			// Only when there is something to copy: a config dir mounted
			// read-only must not fail an apply that writes nothing.
			if dir := path.Dir(destPath); !readyDirs[dir] {
				if err := ensureContainerDir(ctx, cli, container, dir); err != nil {
					return failed(err.Error())
				}
				readyDirs[dir] = true
			}
			dest := container + ":" + destPath
			if _, err := captureProcess(ctx, []string{cli, "cp", target, dest}, true); err != nil {
				return failed(fmt.Sprintf("%s cp %s failed: %v", cli, dest, err))
			}
		}
		written++
		applied = append(applied, f.rel)
		current[f.rel] = true
		if recipe.postconf && strings.HasSuffix(f.rel, ".cf") {
			postconfArgs = append(postconfArgs, postconfSettings(f.content)...)
		}
	}

	// Files dropped from the manifest are deleted, so a retired file or DKIM
	// key is no longer loaded. Only names this agent wrote before are touched.
	removed := 0
	var postconfRemoved []string
	for _, name := range s.AppliedFiles[svc.ServiceID] {
		rel, ok := managedRelPath(name)
		if !ok || current[rel] {
			continue
		}
		target := filepath.Join(c.managedRoot, recipe.targetDir, filepath.FromSlash(rel))
		destPath := ""
		if copyIn {
			destPath = path.Join(recipe.targetDir, rel)
		}
		if err := tx.backup(target, destPath); err != nil {
			return failed("backup failed: " + err.Error())
		}
		old := tx.backups[len(tx.backups)-1]
		if !old.existed {
			tx.backups = tx.backups[:len(tx.backups)-1] // already gone; nothing to restore
			continue
		}
		if err := os.Remove(target); err != nil {
			return failed("remove failed: " + err.Error())
		}
		if copyIn {
			if err := removeInContainer(ctx, cli, container, destPath); err != nil {
				return failed(fmt.Sprintf("removing %s from %s failed: %v", destPath, container, err))
			}
		}
		removed++
		if recipe.postconf && strings.HasSuffix(rel, ".cf") {
			postconfRemoved = append(postconfRemoved, postconfKeys(postconfSettings(string(old.content)))...)
		}
	}
	// A key a removed .cf file set is dropped from main.cf unless a current
	// file still sets it.
	stillSet := map[string]bool{}
	for _, key := range postconfKeys(postconfArgs) {
		stillSet[key] = true
	}
	var postconfUnset []string
	for _, key := range postconfRemoved {
		if !stillSet[key] && !slices.Contains(postconfUnset, key) {
			postconfUnset = append(postconfUnset, key)
		}
	}

	if err := ctx.Err(); err != nil {
		return failed(err.Error())
	}
	summary := fmt.Sprintf("%d file(s)", written)
	if removed > 0 {
		summary += fmt.Sprintf(" written, %d removed", removed)
	}
	if c.applyOnly {
		return applyResult{manifestSha: man.Sha256, status: "succeeded", message: fmt.Sprintf("%s staged under %s (reload skipped: apply-only)", summary, recipe.targetDir), files: written, applied: applied}
	}

	if len(postconfArgs) > 0 || len(postconfUnset) > 0 {
		if err := tx.rememberPostconf(ctx, append(postconfKeys(postconfArgs), postconfUnset...)); err != nil {
			return failed(applyStepError("postconf", man.ServiceType, err))
		}
	}
	steps := [][]string{}
	if len(postconfArgs) > 0 {
		steps = append(steps, append([]string{"postconf", "-e"}, postconfArgs...))
	}
	if len(postconfUnset) > 0 {
		steps = append(steps, append([]string{"postconf", "-X"}, postconfUnset...))
	}
	steps = append(append(steps, recipe.validate...), recipe.reload...)
	for _, cmd := range steps {
		if len(cmd) == 0 {
			continue
		}
		if _, err := runApplyCommand(ctx, c.execArgv(svc.ServiceID, cmd)); err != nil {
			return failed(applyStepError(cmd[0], man.ServiceType, err))
		}
	}
	if len(recipe.reload) == 0 {
		// clamd and Robin read these files only at start.
		return applyResult{manifestSha: man.Sha256, status: "succeeded", message: fmt.Sprintf("%s written; restart %s to load them", summary, man.ServiceType), files: written, applied: applied}
	}
	return applyResult{manifestSha: man.Sha256, status: "succeeded", message: fmt.Sprintf("%s applied and reloaded", summary), files: written, applied: applied}
}

func applyStepError(step, serviceType string, err error) string {
	var missing errToolMissing
	if errors.As(err, &missing) {
		return fmt.Sprintf("%s, so %s could not be validated or reloaded", missing.Error(), serviceType)
	}
	return fmt.Sprintf("%s failed: %v", step, err)
}

// ensureContainerDir makes sure dir exists in the container without running
// anything inside it: minimal images ship no mkdir (dovecot/dovecot 2.4), and
// some have no conf.d until something creates it (dovecot/dovecot 2.3).
// Copying an empty directory's contents creates a missing destination and
// leaves an existing one, and its ownership and mode, untouched.
func ensureContainerDir(ctx context.Context, cli, container, dir string) error {
	empty, err := os.MkdirTemp("", "robin-agent-dir-")
	if err != nil {
		return fmt.Errorf("temp dir: %v", err)
	}
	defer os.RemoveAll(empty)
	// A created destination takes this mode; MkdirTemp's 0700 would hide the
	// service's config from its unprivileged processes.
	if err := os.Chmod(empty, 0o755); err != nil {
		return fmt.Errorf("temp dir: %v", err)
	}
	if _, err := captureProcess(ctx, []string{cli, "cp", empty + "/.", container + ":" + dir}, true); err != nil {
		return fmt.Errorf("%s cp: creating %s in %s failed: %v", cli, dir, container, err)
	}
	return nil
}

// containerExecTarget reports the container CLI and container name when an
// exec prefix runs commands inside a container (`docker exec [flags] <name>`,
// or podman). The name is the prefix's last word, after any flags.
func containerExecTarget(prefix string) (cli, container string) {
	fields := strings.Fields(prefix)
	if len(fields) < 3 || fields[1] != "exec" {
		return "", ""
	}
	if name := filepath.Base(fields[0]); name != "docker" && name != "podman" {
		return "", ""
	}
	last := fields[len(fields)-1]
	if strings.HasPrefix(last, "-") {
		return "", ""
	}
	return fields[0], last
}

// postconfSettings returns the `key = value` settings of a rendered .cf file
// as `postconf -e` arguments, skipping comments and blank lines.
func postconfSettings(content string) []string {
	var out []string
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		key, value, _ := strings.Cut(line, "=")
		out = append(out, strings.TrimSpace(key)+"="+strings.TrimSpace(value))
	}
	return out
}

func postStatus(client *http.Client, c config, s state, serviceID string, result applyResult, started, finished time.Time) {
	body := map[string]any{
		"applyStartedAt":  started.UTC().Format(time.RFC3339),
		"applyFinishedAt": finished.UTC().Format(time.RFC3339),
		"applyStatus":     result.status,
		"manifestSha256":  result.manifestSha,
		"agentVersion":    agentVersion,
		"metadata":        map[string]any{"message": result.message},
	}
	if result.status == "succeeded" {
		body["appliedSha256"] = result.manifestSha
		body["appliedFileCount"] = result.files
	} else {
		body["applyError"] = result.message
	}
	headers := map[string]string{"Authorization": "Bearer " + s.Credential, "X-Robin-Agent-Id": s.AgentID}
	_, _ = postJSON(client, c.adminURL+"/api/fleet/agent/services/"+url.PathEscape(serviceID)+"/status", headers, body, nil)
}

// metricsSample pairs a request-body field with the command that produces its
// raw output. robin-admin parses the output; the agent stays a thin executor.
type metricsSample struct {
	field    string
	argv     []string
	combined bool
}

// Per-type raw metrics commands the agent runs locally. The first sample's
// binary must be present for the type to collect. Co-located exec-only types
// are listed here; network-reachable types stay direct and are polled by
// robin-admin.
var metricsCollectors = map[string][]metricsSample{
	"cyrus": {
		{field: "prometheus", argv: []string{"cat", "/var/lib/cyrus/config/stats/report.txt"}},
		{field: "proc", argv: []string{"cyr_info", "proc"}},
		{field: "version", argv: []string{"master", "-V"}, combined: true},
	},
	"dovecot": {
		{field: "statsDump", argv: []string{"doveadm", "stats", "dump"}},
		{field: "who", argv: []string{"doveadm", "who"}},
		// robin-admin renders config in the syntax of the reported version.
		{field: "version", argv: []string{"dovecot", "--version"}},
	},
	"postfix": {
		{field: "postqueue", argv: []string{"postqueue", "-j"}},
	},
}

func metricsObservationBody(body map[string]any, reachable bool, errorCode string) map[string]any {
	body["reachable"] = reachable
	if errorCode != "" {
		body["errorCode"] = errorCode
	}
	return body
}

// pushServiceMetrics runs the type's collector command(s) and ships the raw
// output to robin-admin, which parses and stores it.
func pushServiceMetrics(parent context.Context, client *http.Client, c config, s state, svc ownedService) {
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	headers := map[string]string{"Authorization": "Bearer " + s.Credential, "X-Robin-Agent-Id": s.AgentID}
	metricsURL := c.adminURL + "/api/fleet/agent/services/" + url.PathEscape(svc.ServiceID) + "/metrics"
	postObservation := func(body map[string]any, reachable bool, errorCode string) {
		if code, err := postJSONContext(parent, client, metricsURL, headers, metricsObservationBody(body, reachable, errorCode), nil); err == nil && code >= 200 && code < 300 {
			log.Printf("robin-agent: pushed metrics observation for %s (%s)", svc.ServiceID, svc.ServiceType)
		}
	}

	// Redis is collected over its own protocol (RESP INFO), not a shell command.
	if svc.ServiceType == "redis" {
		info, err := redisInfo(c.redisAddr)
		if err != nil {
			postObservation(map[string]any{}, false, "collection_failed")
			return
		}
		postObservation(map[string]any{"info": info}, true, "")
		return
	}

	// ClamAV is collected over the clamd TCP protocol (VERSION + STATS).
	if svc.ServiceType == "clamav" {
		version, verr := clamdCommand(c.clamavAddr, "VERSION")
		stats, serr := clamdCommand(c.clamavAddr, "STATS")
		if verr != nil && serr != nil {
			postObservation(map[string]any{}, false, "collection_failed")
			return
		}
		postObservation(map[string]any{"version": version, "stats": stats}, true, "")
		return
	}

	// Rspamd is collected over HTTP from the local controller (/metrics + /stat).
	if svc.ServiceType == "rspamd" {
		ctrlHeaders := map[string]string{}
		if c.rspamdPassword != "" {
			ctrlHeaders["Password"] = c.rspamdPassword
		}
		metricsText, merr := httpGetText(client, c.rspamdURL+"/metrics", ctrlHeaders)
		statJSON, serr := httpGetText(client, c.rspamdURL+"/stat", ctrlHeaders)
		if merr != nil && serr != nil {
			postObservation(map[string]any{}, false, "collection_failed")
			return
		}
		postObservation(map[string]any{"metrics": metricsText, "stat": statJSON}, true, "")
		return
	}

	// Robin is collected over HTTP from its local Prometheus metrics endpoint.
	if svc.ServiceType == "robin" {
		prom, err := httpGetText(client, c.robinMetricsURL+"/metrics/prometheus", nil)
		if err != nil {
			postObservation(map[string]any{}, false, "collection_failed")
			return
		}
		postObservation(map[string]any{"prometheus": prom}, true, "")
		return
	}

	// Postgres is collected by running one consolidated query via psql (no pg
	// client is bundled — the agent stays a thin executor) and shipping the JSON.
	if svc.ServiceType == "postgres" {
		if c.postgresDSN == "" {
			postObservation(map[string]any{}, false, "collector_unavailable")
			return
		}
		if _, err := exec.LookPath("psql"); err != nil {
			postObservation(map[string]any{}, false, "collector_unavailable")
			return
		}
		dsn, env := postgresDSNAndEnv(c.postgresDSN)
		out, err := captureProcessWithEnv(ctx, []string{"psql", dsn, "-tAqc", postgresSnapshotSQL}, false, env)
		if err != nil {
			log.Printf("robin-agent: postgres collect for %s failed: %v", svc.ServiceID, err)
			postObservation(map[string]any{}, false, "collection_failed")
			return
		}
		snap := strings.TrimSpace(string(out))
		if snap == "" {
			postObservation(map[string]any{}, false, "empty_metrics")
			return
		}
		postObservation(map[string]any{"snapshot": snap}, true, "")
		return
	}

	// MariaDB runs one statistics batch through its own client (see mariadb.go).
	if svc.ServiceType == "mariadb" {
		snapshot, errorCode := collectMariadb(ctx, c, svc.ServiceID, time.Now())
		if errorCode != "" {
			postObservation(map[string]any{}, false, errorCode)
			return
		}
		postObservation(map[string]any{"snapshot": snapshot}, true, "")
		return
	}

	samples, ok := metricsCollectors[svc.ServiceType]
	if !ok || len(samples) == 0 {
		postObservation(map[string]any{}, false, "collector_unavailable")
		return
	}
	if primary := c.execArgv(svc.ServiceID, samples[0].argv); len(primary) == 0 {
		postObservation(map[string]any{}, false, "collector_unavailable")
		return
	} else if _, err := exec.LookPath(primary[0]); err != nil {
		postObservation(map[string]any{}, false, "collector_unavailable")
		return
	}
	body := map[string]any{}
	for i, sample := range samples {
		full := c.execArgv(svc.ServiceID, sample.argv)
		if _, err := exec.LookPath(full[0]); err != nil {
			continue
		}
		out, err := captureProcess(ctx, full, sample.combined)
		if err != nil {
			if i == 0 || ctx.Err() != nil || errors.Is(err, errProcessOutputLimit) || errors.Is(err, exec.ErrWaitDelay) {
				log.Printf("robin-agent: metrics collect for %s failed: %v", svc.ServiceID, err)
				postObservation(map[string]any{}, false, "collection_failed")
				return
			}
			continue
		}
		body[sample.field] = string(out)
	}
	if len(body) == 0 {
		postObservation(map[string]any{}, false, "empty_metrics")
		return
	}
	postObservation(body, true, "")
}

// ── Log tailing (Phase 4) ────────────────────────────────────────────────────
// The agent tails a service's journald unit / log file / newest dated file and
// ships the recent lines; robin-admin stores the newest buffer and serves it on
// the Logs page for agent-mode services (it can't reach the host to read logs).
// File/dir tailing is done natively (no tail/grep/sh needed) so a minimal
// log-mount sidecar can serve logs for several services at once.

const logTailLines = 200
const logTailMaxBytes = 1 << 20 // read at most the last 1 MiB of a log file

type logSource struct {
	unit      string
	file      string
	dir       string
	glob      string
	container string // a container whose console output is the log (`docker logs`)
	filter    string
}

// Per-type default log locations, mirroring robin-admin's FILE_LOG_SOURCES.
// Override per host with ROBIN_AGENT_<TYPE>_LOG_{UNIT,FILE,DIR,GLOB,CONTAINER,FILTER},
// and per service with ROBIN_AGENT_LOG_<SERVICE_ID>_{...} (the service id
// upper-cased, other characters as `_`) when one agent runs several services
// of a type — e.g. ROBIN_AGENT_LOG_MX2_FILE=/var/log/mx2/mail.log.
var logCollectors = map[string]logSource{
	"cyrus":    {unit: "cyrus-imapd", file: "/var/log/mail.log", filter: "cyrus/"},
	"clamav":   {unit: "clamav-daemon", file: "/var/log/clamav/clamav.log"},
	"dovecot":  {unit: "dovecot", file: "/var/log/mail.log", filter: "dovecot"},
	"postfix":  {unit: "postfix@-", file: "/var/log/mail.log", filter: "postfix/"},
	"redis":    {unit: "redis-server", file: "/var/log/redis/redis-server.log"},
	"postgres": {unit: "postgresql", dir: "/var/log/postgresql", glob: "*.log"},
	"mariadb":  {unit: "mariadb", file: "/var/log/mysql/error.log"},
	"robin":    {unit: "robin", dir: "/var/log/robin", glob: "*.log"},
	"rspamd":   {file: "/var/log/rspamd/rspamd.log"},
}

func resolveLogSource(serviceType, serviceID string) (logSource, bool) {
	base, ok := logCollectors[serviceType]
	if !ok {
		return logSource{}, false
	}
	src := base
	src.container = ""
	// Least to most specific; each level overrides the one before it.
	for _, prefix := range []string{
		"ROBIN_AGENT_" + strings.ToUpper(serviceType) + "_LOG_",
		"ROBIN_AGENT_LOG_" + envKey(serviceID) + "_",
	} {
		get := func(suffix string) string { return strings.TrimSpace(os.Getenv(prefix + suffix)) }
		set := func(field *string, suffix string) {
			if v := get(suffix); v != "" {
				*field = v
			}
		}
		set(&src.unit, "UNIT")
		set(&src.file, "FILE")
		set(&src.dir, "DIR")
		set(&src.glob, "GLOB")
		set(&src.container, "CONTAINER")
		// An explicit dedicated log (file/dir override) is unfiltered unless a
		// filter was given alongside it — the shared-file filter no longer applies.
		if get("FILE") != "" || get("DIR") != "" {
			src.filter = get("FILTER")
		} else {
			set(&src.filter, "FILTER")
		}
	}
	return src, true
}

// envKey turns a service id into an environment variable name segment.
func envKey(id string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r - 'a' + 'A'
		case (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'):
			return r
		default:
			return '_'
		}
	}, id)
}

func applyLogFilter(lines []string, filter string, n int) []string {
	if filter != "" {
		kept := make([]string, 0, len(lines))
		for _, l := range lines {
			if strings.Contains(l, filter) {
				kept = append(kept, l)
			}
		}
		lines = kept
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

// tailFile reads at most the last logTailMaxBytes of a file and returns its
// lines. If the read started mid-line (file larger than the cap), the leading
// partial line is dropped.
func tailFile(path string, n int, filter string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	start, truncated := int64(0), false
	if fi.Size() > logTailMaxBytes {
		start, truncated = fi.Size()-logTailMaxBytes, true
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if truncated && len(lines) > 0 {
		lines = lines[1:] // drop the partial first line
	}
	return applyLogFilter(lines, filter, n), nil
}

// newestMatch returns the most-recently-modified file matching dir/glob — for
// services that rotate the active log by filename (Postgres, Robin dated logs).
func newestMatch(dir, glob string) (string, error) {
	matches, err := filepath.Glob(filepath.Join(dir, glob))
	if err != nil {
		return "", err
	}
	var newest string
	var newestMod time.Time
	for _, m := range matches {
		fi, err := os.Stat(m)
		if err != nil {
			continue
		}
		if newest == "" || fi.ModTime().After(newestMod) {
			newest, newestMod = m, fi.ModTime()
		}
	}
	if newest == "" {
		return "", fmt.Errorf("no readable file matching %s/%s", dir, glob)
	}
	return newest, nil
}

// logCursor remembers where the previous push ended, so each cycle ships only
// the lines written since (Postfix message counters are derived from them). The
// first push after start ships the recent tail with reset=true: robin-admin
// replaces its buffer and does not count those lines, so a restart never
// double-counts.
type logCursor struct {
	source  string
	path    string // file/dir sources: the file being followed
	offset  int64
	file    os.FileInfo // identity of the followed file, to notice rotation
	journal string      // journald cursor
	since   time.Time   // container sources: newest docker log timestamp seen
}

// logCursors is keyed by service ID; only the sync loop touches it.
var logCursors = map[string]*logCursor{}

// readFrom returns the complete lines written to path after offset, the
// offset just past the last complete line, and the file's identity. A file
// that is not `prev` (rotated, even if it already grew past offset) or has
// shrunk (truncated) is read from the start; more than logTailMaxBytes of
// backlog is skipped down to the newest logTailMaxBytes.
func readFrom(path string, offset int64, prev os.FileInfo) ([]string, int64, os.FileInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, offset, prev, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, offset, prev, err
	}
	size := fi.Size()
	if size < offset || (prev != nil && !os.SameFile(prev, fi)) {
		offset = 0
	}
	skipPartial := false
	if size-offset > logTailMaxBytes {
		offset, skipPartial = size-logTailMaxBytes, true
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, offset, fi, err
	}
	data, err := io.ReadAll(io.LimitReader(f, size-offset))
	if err != nil {
		return nil, offset, fi, err
	}
	end := bytes.LastIndexByte(data, '\n')
	if end < 0 {
		return nil, offset, fi, nil // no complete line yet
	}
	lines := strings.Split(string(data[:end]), "\n")
	if skipPartial && len(lines) > 0 {
		lines = lines[1:]
	}
	return lines, offset + int64(end) + 1, fi, nil
}

// journald prints "-- cursor: <c>" last when --show-cursor is set.
func journaldRead(ctx context.Context, unit, filter string, extra ...string) (lines []string, cursor string, err error) {
	args := append([]string{"-u", unit, "--no-pager", "-o", "short-iso", "--show-cursor"}, extra...)
	if filter != "" {
		args = append(args, "--grep", filter)
	}
	out, err := captureProcess(ctx, append([]string{"journalctl"}, args...), false)
	if err != nil {
		return nil, "", err
	}
	for _, l := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		switch {
		case strings.HasPrefix(l, "-- cursor: "):
			cursor = strings.TrimPrefix(l, "-- cursor: ")
		case strings.TrimSpace(l) == "", strings.HasPrefix(l, "-- No entries --"):
		default:
			lines = append(lines, l)
		}
	}
	return lines, cursor, nil
}

// containerRead reads a container's stdout/stderr log (services that log to the
// console rather than a file), returning lines newer than since without the
// docker timestamp prefix, and the newest timestamp seen.
func containerRead(ctx context.Context, container, filter string, since time.Time, extra ...string) ([]string, time.Time, error) {
	args := append([]string{"logs", "--timestamps"}, extra...)
	out, err := captureProcess(ctx, append([]string{"docker"}, append(args, container)...), true)
	if err != nil {
		return nil, since, fmt.Errorf("docker logs %s: %v", container, err)
	}
	newest := since
	var lines []string
	for _, l := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		stamp, text, ok := strings.Cut(l, " ")
		ts, err := time.Parse(time.RFC3339Nano, stamp)
		if !ok || err != nil || !ts.After(since) {
			continue
		}
		newest = ts
		lines = append(lines, text)
	}
	return applyLogFilter(lines, filter, len(lines)), newest, nil
}

// collectNewLogs returns the lines written since the previous call for this
// service, or — on the first call — the recent tail with reset=true.
func collectNewLogs(parent context.Context, svc ownedService) (source string, lines []string, reset bool, ok bool) {
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	src, known := resolveLogSource(svc.ServiceType, svc.ServiceID)
	if !known {
		return "", nil, false, false
	}
	cur := logCursors[svc.ServiceID]
	first := cur == nil
	if first {
		cur = &logCursor{}
	}

	path := ""
	if src.container == "" && src.file != "" {
		if _, err := os.Stat(src.file); err == nil {
			path = src.file
		}
	}
	if path == "" && src.container == "" && src.dir != "" && src.glob != "" {
		path, _ = newestMatch(src.dir, src.glob)
	}
	switch {
	case path != "":
		if first || cur.path != path {
			// Start following at the current end; ship the recent tail as the reset buffer.
			tail, err := tailFile(path, logTailLines, src.filter)
			info, serr := os.Stat(path)
			if err != nil || serr != nil {
				return "", nil, false, false
			}
			*cur = logCursor{source: path, path: path, offset: info.Size(), file: info}
			logCursors[svc.ServiceID] = cur
			return path, tail, true, true
		}
		fresh, offset, info, err := readFrom(path, cur.offset, cur.file)
		if err != nil {
			delete(logCursors, svc.ServiceID)
			return "", nil, false, false
		}
		cur.offset, cur.file = offset, info
		return cur.source, applyLogFilter(fresh, src.filter, len(fresh)), false, true

	case src.container != "":
		if first {
			tail, newest, err := containerRead(ctx, src.container, src.filter, time.Time{}, "--tail", strconv.Itoa(logTailLines*10))
			if err != nil {
				return "", nil, false, false
			}
			*cur = logCursor{source: "docker logs " + src.container, since: newest}
			if cur.since.IsZero() {
				cur.since = time.Now()
			}
			logCursors[svc.ServiceID] = cur
			return cur.source, applyLogFilter(tail, "", logTailLines), true, true
		}
		fresh, newest, err := containerRead(ctx, src.container, src.filter, cur.since, "--since", cur.since.Format(time.RFC3339Nano))
		if err != nil {
			return "", nil, false, false
		}
		cur.since = newest
		return cur.source, fresh, false, true

	case src.unit != "":
		if _, err := exec.LookPath("journalctl"); err != nil {
			return "", nil, false, false
		}
		if first || cur.journal == "" {
			tail, cursor, err := journaldRead(ctx, src.unit, src.filter, "-n", strconv.Itoa(logTailLines))
			if err != nil {
				return "", nil, false, false
			}
			*cur = logCursor{source: "journalctl -u " + src.unit, journal: cursor}
			logCursors[svc.ServiceID] = cur
			return cur.source, tail, true, true
		}
		fresh, cursor, err := journaldRead(ctx, src.unit, src.filter, "--after-cursor", cur.journal)
		if err != nil {
			return "", nil, false, false
		}
		if cursor != "" {
			cur.journal = cursor
		}
		return cur.source, fresh, false, true
	}
	return "", nil, false, false
}

// pushServiceLogs ships the service's new log lines. Quiet cycles still push
// (an empty batch), which tells robin-admin the log source is live.
func pushServiceLogs(ctx context.Context, client *http.Client, c config, s state, svc ownedService) {
	source, lines, reset, ok := collectNewLogs(ctx, svc)
	if !ok {
		return
	}
	if lines == nil {
		lines = []string{} // a quiet cycle must encode as [], not null
	}
	headers := map[string]string{"Authorization": "Bearer " + s.Credential, "X-Robin-Agent-Id": s.AgentID}
	logsURL := c.adminURL + "/api/fleet/agent/services/" + url.PathEscape(svc.ServiceID) + "/logs"
	body := map[string]any{"source": source, "lines": lines, "reset": reset}
	if code, err := postJSONContext(ctx, client, logsURL, headers, body, nil); err != nil || code < 200 || code >= 300 {
		// Re-prime next cycle so the lost batch is replaced rather than silently skipped from counts.
		delete(logCursors, svc.ServiceID)
	} else if len(lines) > 0 {
		log.Printf("robin-agent: pushed %d log line(s) for %s (%s)", len(lines), svc.ServiceID, svc.ServiceType)
	}
}

// syncConfig pulls each owned service's manifest and applies any change, and
// pushes metrics for services the agent can collect for.
func syncConfig(ctx context.Context, client *http.Client, c config, s *state, actions *actionSet) {
	if s.LastApplied == nil {
		s.LastApplied = map[string]string{}
	}
	var env apiEnvelope
	code, err := agentGet(ctx, client, c.adminURL+"/api/fleet/agent/services", *s, &env)
	if err != nil || code < 200 || code >= 300 || !env.Success {
		return
	}
	var services []ownedService
	if err := json.Unmarshal(env.Data, &services); err != nil {
		return
	}
	actions.set(serviceReports(c, services, func(serviceID, tool string) bool { return tools.present(ctx, c, serviceID, tool) }))
	for _, svc := range services {
		if ctx.Err() != nil {
			return
		}
		if svc.CollectMetrics {
			pushServiceMetrics(ctx, client, c, *s, svc)
		}
		if svc.CollectLogs {
			pushServiceLogs(ctx, client, c, *s, svc)
		}
		if !svc.CollectConfig {
			continue // logs-only responsibility (metrics/config stay direct)
		}
		started := time.Now()
		result := applyService(ctx, client, c, *s, svc)
		if result.status == "" {
			continue // config unchanged
		}
		postStatus(client, c, *s, svc.ServiceID, result, started, time.Now())
		if result.status == "succeeded" {
			s.LastApplied[svc.ServiceID] = result.manifestSha
			if s.AppliedFiles == nil {
				s.AppliedFiles = map[string][]string{}
			}
			s.AppliedFiles[svc.ServiceID] = result.applied
			if err := saveState(c.statePath, *s); err != nil {
				log.Printf("robin-agent: warning: could not persist state: %v", err)
			}
			log.Printf("robin-agent: applied config for %s (%s): %s", svc.ServiceID, svc.ServiceType, result.message)
		} else {
			log.Printf("robin-agent: config apply failed for %s: %s", svc.ServiceID, result.message)
		}
	}
}

func main() {
	for _, a := range os.Args[1:] {
		if a == "-version" || a == "--version" || a == "-v" {
			fmt.Println("robin-agent", agentVersion)
			return
		}
	}

	log.SetFlags(log.LstdFlags | log.LUTC)
	c, err := loadConfig()
	if err != nil {
		log.Fatalf("robin-agent: %v", err)
	}
	client := newHTTPClient(c.insecureTLS)

	s, ok := loadState(c.statePath)
	if !ok && c.agentID != "" && c.credential != "" {
		// Pre-provisioned credential (ROBIN_AGENT_CREDENTIAL) — skip enrollment.
		s = state{AgentID: c.agentID, Credential: c.credential}
		if err := saveState(c.statePath, s); err != nil {
			log.Printf("robin-agent: warning: could not persist state to %s: %v", c.statePath, err)
		}
		log.Printf("robin-agent %s: using provisioned credential for agent %s", agentVersion, s.AgentID)
	} else if !ok {
		log.Printf("robin-agent %s: no stored credential; enrolling with %s", agentVersion, c.adminURL)
		s, err = enroll(client, c)
		if err != nil {
			log.Fatalf("robin-agent: %v", err)
		}
		if err := saveState(c.statePath, s); err != nil {
			log.Printf("robin-agent: warning: could not persist state to %s: %v", c.statePath, err)
		}
		log.Printf("robin-agent: enrolled as agent %s", s.AgentID)
	} else {
		log.Printf("robin-agent %s: resuming as agent %s", agentVersion, s.AgentID)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	actions := &actionSet{}
	interval := 30 * time.Second
	probeEnabled, err := heartbeat(client, c, s, nil)
	if err != nil {
		log.Printf("robin-agent: initial heartbeat: %v", err)
	} else {
		log.Printf("robin-agent: online (heartbeat + config sync every %s, commands via long-poll)", interval)
	}
	syncConfig(ctx, client, c, &s, actions)
	// Report right away what this agent can do, rather than a cycle later.
	if enabled, err := heartbeat(client, c, s, actions.serviceReports()); err != nil {
		log.Printf("robin-agent: heartbeat: %v", err)
	} else {
		probeEnabled = enabled
	}
	probeRuntime := newProbeRuntime(client, c, s, probeEnabled)
	go probeRuntime.run(ctx)
	go pollCommands(ctx, c, s, actions)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Printf("robin-agent: shutting down")
			return
		case <-ticker.C:
			if enabled, err := heartbeat(client, c, s, actions.serviceReports()); err != nil {
				log.Printf("robin-agent: heartbeat: %v", err)
			} else {
				probeRuntime.SetEnabled(enabled)
			}
			syncConfig(ctx, client, c, &s, actions)
		}
	}
}
