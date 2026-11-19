package main

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type securityEvent struct {
	ID             string    `json:"id"`
	ObservedAt     time.Time `json:"observedAt"`
	Type           string    `json:"type"`
	User           string    `json:"user,omitempty"`
	SourceIP       string    `json:"sourceIp,omitempty"`
	AuthMethod     string    `json:"authMethod,omitempty"`
	KeyFingerprint string    `json:"keyFingerprint,omitempty"`
	Process        string    `json:"process"`
	Line           string    `json:"line"`
}

type securityCounter struct {
	Minute                time.Time `json:"minute"`
	InvalidUser           int       `json:"invalidUser"`
	FailedKey             int       `json:"failedKey"`
	FailedPassword        int       `json:"failedPassword"`
	Successful            int       `json:"successful"`
	DistinctFailedSources int       `json:"distinctFailedSources"`
}

type securityCounterWindow struct {
	Counter securityCounter `json:"counter"`
	Sources map[string]bool `json:"sources"`
}

type securityEventBatch struct {
	Version  int               `json:"version"`
	BatchID  string            `json:"batchId"`
	Events   []securityEvent   `json:"events"`
	Counters []securityCounter `json:"counters"`
}

type securityLogState struct {
	AgentID          string                            `json:"agentId"`
	Cursor           *logCursor                        `json:"cursor,omitempty"`
	Pending          *securityEventBatch               `json:"pending,omitempty"`
	Windows          map[string]*securityCounterWindow `json:"windows"`
	LastClosedMinute time.Time                         `json:"lastClosedMinute,omitzero"`
}

var securityLogMasks = []logMaskRule{
	{pattern: authorizationPattern, replacement: "${1}[REDACTED]"},
	{pattern: credentialJSONPattern, replacement: "${1}\"[REDACTED]\""},
	{pattern: credentialPattern, replacement: "$1$2[REDACTED]"},
	{pattern: bearerPattern, replacement: "${1}[REDACTED]"},
	{pattern: authPlainPattern, replacement: "${1}[REDACTED]${2}"},
}
var securityKeyMaterial = regexp.MustCompile(`(?i)(ssh-(?:rsa|ed25519|dss)|ecdsa-[a-z0-9@.-]+|sk-[a-z0-9@.-]+)\s+[A-Za-z0-9+/]{24,}={0,2}`)
var sshAccepted = regexp.MustCompile(`(?i)\bAccepted (\S+) for (\S+) from (\S+) port \d+`)
var sshFingerprint = regexp.MustCompile(`\bSHA256:[A-Za-z0-9+/]{43}\b`)
var sshFailed = regexp.MustCompile(`(?i)\b(?:Failed (password|publickey) for (invalid user )?\S+|Invalid user \S+) from (\S+)`)
var accountChanged = regexp.MustCompile(`\b(?:name|user)=['"]?([^,'";\s]+)`)
var sudoActor = regexp.MustCompile(`sudo(?:\[\d+\])?:\s*(\S+)\s*:`)
var auditRule = regexp.MustCompile(`\bkey=(?:"([^"]+)"|([^\s]+))`)
var fail2banIP = regexp.MustCompile(`\b(Unban|Ban)\s+(\S+)`)

func classifySecurityLine(line string, keys map[string]bool) (securityEvent, string, string) {
	e := securityEvent{}
	lower := strings.ToLower(line)
	if strings.Contains(lower, "sshd") {
		if match := sshFailed.FindStringSubmatch(line); match != nil {
			kind := "invalid_user"
			if match[2] == "" {
				switch strings.ToLower(match[1]) {
				case "password":
					kind = "failed_password"
				case "publickey":
					kind = "failed_key"
				}
			}
			return e, kind, match[3]
		}
		if match := sshAccepted.FindStringSubmatch(line); match != nil && net.ParseIP(match[3]) != nil {
			e.Type = "login"
			e.User = securityText(match[2])
			e.SourceIP = match[3]
			e.AuthMethod = securityText(strings.ToLower(match[1]))
			e.KeyFingerprint = sshFingerprint.FindString(line)
			e.Process = "sshd"
		} else if strings.Contains(lower, "sighup") || strings.Contains(lower, "reloading") || strings.Contains(lower, "reloaded") {
			e.Type = "sshd_reload"
			e.Process = "sshd"
		}
	}
	if e.Type == "" && strings.Contains(lower, "sudo") {
		if match := sudoActor.FindStringSubmatch(line); match != nil {
			e.Type = "sudo"
			e.User = securityText(match[1])
			e.Process = "sudo"
		}
	}
	if e.Type == "" && (strings.Contains(lower, " su[") || strings.Contains(lower, " su:")) {
		e.Type = "su"
		e.Process = "su"
	}
	if e.Type == "" {
		for _, candidate := range []struct{ process, kind string }{
			{"useradd", "user_change"}, {"usermod", "user_change"}, {"userdel", "user_change"},
			{"groupadd", "group_change"}, {"groupmod", "group_change"}, {"groupdel", "group_change"},
			{"passwd", "password_change"}, {"chpasswd", "password_change"},
		} {
			if strings.Contains(lower, " "+candidate.process+"[") || strings.Contains(lower, " "+candidate.process+":") {
				e.Type = candidate.kind
				e.Process = candidate.process
				if match := accountChanged.FindStringSubmatch(line); match != nil {
					e.User = securityText(match[1])
				}
				break
			}
		}
	}
	if e.Type == "" && strings.Contains(lower, "fail2ban") {
		if match := fail2banIP.FindStringSubmatch(line); match != nil && net.ParseIP(match[2]) != nil {
			e.Type = "fail2ban_" + strings.ToLower(match[1])
			e.SourceIP = match[2]
			e.Process = "fail2ban"
		}
	}
	if e.Type == "" && len(keys) > 0 {
		if match := auditRule.FindStringSubmatch(line); match != nil && (keys[match[1]] || keys[match[2]]) {
			e.Type = "auditd"
			e.Process = "auditd"
		}
	}
	switch e.Type {
	case "login", "sshd_reload", "fail2ban_ban", "fail2ban_unban":
		e.Line = securityText(line)
	case "sudo":
		prefix, _, _ := strings.Cut(line, "COMMAND=")
		e.Line = securityText(prefix) + " [command details redacted]"
	case "su", "user_change", "group_change", "password_change", "auditd":
		e.Line = e.Process + " [" + e.Type + " details redacted]"
	}
	return e, "", ""
}

const hostSecurityJournalFilter = `Accepted|Failed (password|publickey)|Invalid user|sudo|su\[|useradd|usermod|userdel|groupadd|groupmod|groupdel|passwd|fail2ban|SIGHUP|Reload|type=SYSCALL`

func readHostSecurityLog(ctx context.Context, cursor *logCursor) (*logBatch, bool, error) {
	// Use one auth stream so journald and traditional syslog cannot double count.
	if cursor == nil || cursor.Key == "host-journal" {
		batch, more, err := followJournalWithTail(ctx, "host-journal", "", hostSecurityJournalFilter, cursor, 100, 32<<10)
		if err == nil && (cursor != nil || batch.Next.Journal != "") {
			return batch, more, nil
		}
	}
	for _, path := range []string{"/var/log/auth.log", "/var/log/secure"} {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			if cursor != nil && cursor.Key != path {
				cursor = nil
			}
			batch, more, err := followFileWithTail(path, path, "", cursor, 256<<10, 500, 100, 32<<10)
			if err == nil {
				return batch, more, nil
			}
		}
	}
	if cursor != nil && cursor.Key != "host-journal" {
		cursor = nil
	}
	return followJournalWithTail(ctx, "host-journal", "", hostSecurityJournalFilter, cursor, 100, 32<<10)
}

func saveHostSecurityLog(path string, data *securityLogState) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".host-security-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(raw); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func securityRecordCounter(windows map[string]*securityCounterWindow, t time.Time, kind, ip string) {
	minute := t.UTC().Truncate(time.Minute)
	key := minute.Format(time.RFC3339)
	bucket := windows[key]
	if bucket == nil {
		bucket = &securityCounterWindow{Counter: securityCounter{Minute: minute}, Sources: map[string]bool{}}
		windows[key] = bucket
	}
	switch kind {
	case "invalid_user":
		bucket.Counter.InvalidUser++
	case "failed_key":
		bucket.Counter.FailedKey++
	case "failed_password":
		bucket.Counter.FailedPassword++
	case "login":
		bucket.Counter.Successful++
	}
	// Keep addresses out of telemetry and bound the temporary set during a flood.
	if parsed := net.ParseIP(ip); parsed != nil && len(bucket.Sources) < 4096 {
		bucket.Sources[securityHash([]byte(parsed.String()))] = true
		bucket.Counter.DistinctFailedSources = len(bucket.Sources)
	}
}

func securityPost(ctx context.Context, client *http.Client, c config, s state, endpoint string, body any) (int, error) {
	return postJSONContext(ctx, client, c.adminURL+"/api/fleet/agent/host-security/"+endpoint, map[string]string{
		"Authorization": "Bearer " + s.Credential, "X-Robin-Agent-Id": s.AgentID,
	}, body, nil)
}

func shipHostSecurityEvents(ctx context.Context, client *http.Client, c config, s state, cfg securityConfig, path string, data *securityLogState) error {
	if data.Pending == nil {
		input, more, err := readHostSecurityLog(ctx, data.Cursor)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		if input == nil {
			if data.Cursor == nil {
				return nil
			}
			input = &logBatch{Next: *data.Cursor}
		}
		events := []securityEvent{}
		// On first enrollment or source reset take the position without alerting on old events.
		if !input.Reset {
			for i, line := range input.Lines {
				observed := now
				if i < len(input.Times) {
					if t, err := time.Parse(time.RFC3339Nano, input.Times[i]); err == nil {
						observed = t.UTC()
					}
				}
				event, failed, ip := classifySecurityLine(line, cfg.auditKeys)
				if failed != "" {
					securityRecordCounter(data.Windows, observed, failed, ip)
					continue
				}
				if event.Type == "" {
					continue
				}
				event.ObservedAt = observed
				if event.Type == "login" {
					securityRecordCounter(data.Windows, observed, "login", "")
				}
				position, _ := json.Marshal(input.Next)
				event.ID = securityHash(append(position, []byte("|"+strconv.Itoa(i))...))
				if len(events) < 500 {
					events = append(events, event)
				}
			}
		}
		counters := []securityCounter{}
		if input.Reset {
			data.LastClosedMinute = now.Truncate(time.Minute)
		} else if !more {
			last := now.Truncate(time.Minute).Add(-time.Minute)
			first := data.LastClosedMinute.Add(time.Minute)
			if data.LastClosedMinute.IsZero() || last.Sub(first) > time.Hour {
				first = last
			}
			for minute := first; !minute.After(last); minute = minute.Add(time.Minute) {
				securityRecordCounter(data.Windows, minute, "", "")
				data.LastClosedMinute = minute
			}
		}
		if !more || len(data.Windows) > 16 {
			for key, bucket := range data.Windows {
				if bucket.Counter.Minute.Before(now.Truncate(time.Minute)) {
					counters = append(counters, bucket.Counter)
					delete(data.Windows, key)
				}
			}
		}
		data.Cursor = &input.Next
		if len(events) > 0 || len(counters) > 0 {
			data.Pending = &securityEventBatch{Version: 1, BatchID: securityHash([]byte(time.Now().UTC().Format(time.RFC3339Nano) + s.AgentID)), Events: events, Counters: counters}
		}
		if err := saveHostSecurityLog(path, data); err != nil {
			return err
		}
	}
	if data.Pending == nil {
		return nil
	}
	// Persist before transmission on every attempt, including a retry after a disk error.
	if err := saveHostSecurityLog(path, data); err != nil {
		return err
	}
	code, err := securityPost(ctx, client, c, s, "events", data.Pending)
	if err != nil {
		return err
	}
	if code < 200 || code >= 300 {
		return errors.New("server did not acknowledge security events")
	}
	data.Pending = nil
	return saveHostSecurityLog(path, data)
}

func runHostSecurity(ctx context.Context, client *http.Client, c config, s state, cfg securityConfig) {
	snapshotDelay := time.NewTimer(time.Duration(rand.Int64N(int64(10 * time.Second))))
	defer snapshotDelay.Stop()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	path := c.statePath + ".host-security.json"
	data := securityLogState{AgentID: s.AgentID, Windows: map[string]*securityCounterWindow{}}
	if raw, err := os.ReadFile(path); err == nil {
		var previous securityLogState
		if json.Unmarshal(raw, &previous) == nil && previous.AgentID == s.AgentID && previous.Windows != nil {
			data = previous
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		log.Printf("robin-agent: host security state unavailable: %v", err)
	}
	readEvents := func() {
		reading, cancel := context.WithTimeout(ctx, 8*time.Second)
		err := shipHostSecurityEvents(reading, client, c, s, cfg, path, &data)
		cancel()
		if err != nil && ctx.Err() == nil {
			log.Printf("robin-agent: host security events: %v", err)
		}
	}
	readEvents()
	lastHash := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-snapshotDelay.C:
			collection, cancel := context.WithTimeout(ctx, 20*time.Second)
			sections := collectSecuritySnapshot(collection, cfg)
			cancel()
			raw, _ := json.Marshal(sections)
			hash := securityHash(raw)
			body := map[string]any{"version": 1, "hash": hash, "observedAt": time.Now().UTC(), "intervalSeconds": int(cfg.interval / time.Second)}
			if hash != lastHash {
				body["sections"] = sections
			}
			code, err := securityPost(ctx, client, c, s, "snapshot", body)
			if err == nil && code == http.StatusConflict && body["sections"] == nil {
				body["sections"] = sections
				code, err = securityPost(ctx, client, c, s, "snapshot", body)
			}
			if err == nil && code >= 200 && code < 300 {
				lastHash = hash
			} else {
				log.Printf("robin-agent: security snapshot rejected (status %d)", code)
			}
			jitter := time.Duration(rand.Int64N(int64(cfg.interval / 10)))
			snapshotDelay.Reset(cfg.interval + jitter)
		case <-ticker.C:
			readEvents()
		}
	}
}
