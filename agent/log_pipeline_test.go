package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestDeferredLogRateWindowConfigurationChanges(t *testing.T) {
	for _, change := range []string{"mask", "filter", "disable"} {
		t.Run(change, func(t *testing.T) {
			cfg := logPipelineConfig{rate: 1, burst: 2, minimumLevel: -1}
			now := time.Now()
			state := logPipelineState{
				logStreamState: logStreamState{HeldOpen: true, HeldRateWindow: 1},
				rateWindow:     1,
			}
			out, state, counters := finishLogRateWindows([]logEntry{{line: "DEBUG deferred", rawLines: 1}}, cfg, state, logCounters{}, now)
			if len(out) != 0 || len(state.RateWindows) != 1 {
				t.Fatalf("entry was not deferred: %+v %+v", out, state)
			}
			state.rateWindow = 2
			if change != "disable" {
				state.HeldOpen = false
			}
			switch change {
			case "mask":
				cfg.authMask = true
			case "filter":
				cfg.exclude = []logPattern{{text: "deferred"}}
			case "disable":
				cfg.rate = 0
			}
			out, state, counters = finishLogRateWindows(nil, cfg, state, counters, now.Add(time.Second))
			if len(state.RateWindows) != 0 {
				t.Fatal("completed or disabled window was not drained")
			}
			switch change {
			case "mask":
				if len(out) != 1 || out[0].line != "[REDACTED]" {
					t.Fatalf("changed mask exposed stale output: %+v", out)
				}
			case "filter":
				if len(out) != 0 || counters.Excluded != 1 {
					t.Fatalf("changed filter retained stale output: %+v %+v", out, counters)
				}
			case "disable":
				state.rateWindow = 3
				out, _, _ = finishLogRateWindows([]logEntry{{line: "ERROR completed", rateWindow: 1}}, cfg, state, counters, now.Add(2*time.Second))
				if len(out) != 1 || out[0].line != "ERROR completed" {
					t.Fatalf("entry from a drained window was lost: %+v", out)
				}
			}
		})
	}
}

func TestDeferredLogRateWindowBufferIsBounded(t *testing.T) {
	cfg := logPipelineConfig{rate: 1, burst: 2, minimumLevel: -1}
	state := logPipelineState{
		logStreamState: logStreamState{HeldOpen: true, HeldRateWindow: 1},
		rateWindow:     1,
	}
	line := strings.Repeat("x", 64<<10)
	entries := make([]logEntry, 257)
	for i := range entries {
		entries[i] = logEntry{line: line, rawLines: 1}
	}
	out, state, counters := finishLogRateWindows(entries, cfg, state, logCounters{}, time.Now())
	if len(out) != 0 || len(state.RateWindows) != 1 || len(state.RateWindows[0].Entries) != 256 ||
		counters.RateLimited != 1 || state.PendingRateDrops != 1 {
		t.Fatalf("deferred buffer cap did not account for overflow: windows=%d counters=%+v", len(state.RateWindows), counters)
	}
}

func TestLogPipelineStripsANSIAndExcludeOverridesInclude(t *testing.T) {
	cfg := logPipelineConfig{
		include:      []logPattern{{text: "WARN"}},
		exclude:      []logPattern{{text: "invalid line ending"}},
		minimumLevel: -1,
		entryStart:   regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`),
		entryLines:   10,
		entryBytes:   4096,
	}
	now := time.Now()
	lines, _, _, counters := applyLogPipeline(
		[]string{"2026-11-10 WARN \x1b[31minvalid line ending\x1b[0m", "2026-11-10 WARN kept", "2026-11-10 WARN invalid line ending"},
		nil, cfg, logPipelineState{}, logCounters{}, now.Add(3*time.Second),
	)
	if len(lines) != 1 || lines[0] != "2026-11-10 WARN kept" || counters.Excluded != 1 {
		t.Fatalf("exclude must win over include after ANSI stripping: lines=%q counters=%+v", lines, counters)
	}
}

func TestLogPipelineRejectsUnknownMaskPreset(t *testing.T) {
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK_PRESETS", "email;auht")
	if _, err := loadLogPipelineConfig("rspamd", "mask"); err == nil || !strings.Contains(err.Error(), "auht") {
		t.Fatalf("unknown mask preset should fail configuration: %v", err)
	}
}

func TestLogPipelineMasksAuthCredentialsByDefault(t *testing.T) {
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK_PRESETS", "")
	cfg, err := loadLogPipelineConfig("rspamd", "default-auth")
	if err != nil {
		t.Fatal(err)
	}
	lines, _, _, _ := applyLogPipeline([]string{
		"AUTH PLAIN dXNlcjpwYXNz",
		"235 authenticated",
		"a AUTHENTICATE PLAIN aW1hcHNlY3JldA==",
		"a OK authenticated",
		`{"message":"AUTH PLAIN c2VjcmV0LWpzb24="}`,
		"235 authenticated",
		"AUTH PLAIN c2VjcmV0LXdpma|wire",
		"235 authenticated",
		"AUTH PLAIN trace_id=mail",
		"334 ",
		"YXV0aGNoYWxsZW5nZQ==",
		"235 authenticated",
		"a LOGIN alice supersecret",
		"AUTH LOGIN",
		"dXNlcg==",
		"cGFzcw==",
		"235 authenticated",
		"b AUTHENTICATE LOGIN trace_id=mail",
		"334 VXNlcm5hbWU6",
		"ZXhhbXBsZQ==",
		"334 UGFzc3dvcmQ6",
		"c3VwZXJwYXNz",
		"b OK authenticated",
		"bWU",
		"_w",
	}, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	output := strings.Join(lines, "\n")
	for _, secret := range []string{"dXNlcjpwYXNz", "aW1hcHNlY3JldA==", "c2VjcmV0LWpzb24=", "c2VjcmV0LXdpma", "YXV0aGNoYWxsZW5nZQ==", "alice", "supersecret", "dXNlcg==", "cGFzcw==", "ZXhhbXBsZQ==", "c3VwZXJwYXNz"} {
		if strings.Contains(output, secret) {
			t.Fatalf("default masking exposed %q: %s", secret, output)
		}
	}
	for _, line := range lines {
		if line == "bWU" || line == "_w" {
			t.Fatalf("default masking exposed a standalone auth payload: %s", output)
		}
	}
	if !strings.Contains(output, "AUTH PLAIN [REDACTED]") || !strings.Contains(output, "LOGIN [REDACTED] [REDACTED]") {
		t.Fatalf("default authentication masking was not applied: %s", output)
	}
}

func TestIMAPLoginMasksEscapedQuotedCredentials(t *testing.T) {
	cfg, err := loadLogPipelineConfig("rspamd", "imap-quotes")
	if err != nil {
		t.Fatal(err)
	}
	input := []string{
		`a LOGIN alice unquoted-secret`,
		`b LOGIN "alice smith" "quoted secret"`,
		`c LOGIN "ali\"ce" "prefix\"escaped-secret"`,
		`d LOGIN "ali\\ce" "prefix\\backslash-secret"`,
	}
	lines, _, _, _ := applyLogPipeline(input, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	if len(lines) != len(input) {
		t.Fatalf("unexpected IMAP output: %q", lines)
	}
	for _, line := range lines {
		if !strings.Contains(line, "LOGIN [REDACTED] [REDACTED]") || strings.Contains(line, "secret") {
			t.Fatalf("IMAP credentials were not fully masked: %q", line)
		}
	}
}

func TestCredentialMasksHandleIncompleteAndEscapedQuotedValues(t *testing.T) {
	cfg, err := loadLogPipelineConfig("rspamd", "incomplete-quotes")
	if err != nil {
		t.Fatal(err)
	}
	input := []string{
		`password="prefix hidden-one`,
		`password='prefix hidden-two`,
		`password='prefix\' hidden-three'`,
		`{"password":"prefix hidden-four}`,
		`a LOGIN "alice first hidden-five`,
		`b LOGIN alice "prefix hidden-six`,
		`c LOGIN hidden-seven`,
	}
	lines, _, _, _ := applyLogPipeline(input, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	text := strings.Join(lines, "\n")
	for _, secret := range []string{"hidden-one", "hidden-two", "hidden-three", "hidden-four", "hidden-five", "hidden-six", "hidden-seven"} {
		if strings.Contains(text, secret) {
			t.Fatalf("incomplete or escaped credential leaked %q: %q", secret, lines)
		}
	}
}

func TestLogPipelineMasksJSONCredentialsAndLoginChallenges(t *testing.T) {
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK_PRESETS", "auth")
	cfg, err := loadLogPipelineConfig("rspamd", "mask")
	if err != nil {
		t.Fatal(err)
	}
	input := []string{
		`{"password":"secret\"value","api_key":"test-key","token":"test-token","Authorization":"Basic dXNlcjpwYXNz"}`,
		"AUTH LOGIN",
		"334 VXNlcm5hbWU6",
		"dXNlcg==",
		"334 UGFzc3dvcmQ6",
		"cGFzc3dvcmQ=",
		"235 authenticated",
	}
	lines, _, state, _ := applyLogPipeline(input, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	text := strings.Join(lines, "\n")
	for _, secret := range []string{`secret\"value`, "test-key", "test-token", "dXNlcjpwYXNz", "dXNlcg==", "cGFzc3dvcmQ="} {
		if strings.Contains(text, secret) {
			t.Fatalf("credential %q appeared in output: %q", secret, lines)
		}
	}
	var object map[string]string
	if err := json.Unmarshal([]byte(lines[0]), &object); err != nil || object["password"] != "[REDACTED]" {
		t.Fatalf("JSON credentials were not safely redacted: %q (%v)", lines[0], err)
	}
	if state.LoginRemaining != 0 {
		t.Fatalf("SMTP login state was not cleared: %+v", state)
	}
}

func TestHeldRawEntryIsEncryptedAndFilteredAfterRestart(t *testing.T) {
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_EXCLUDE", "password=should-block")
	cfg, err := loadLogPipelineConfig("rspamd", "held")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	lines, _, pipeline, counters := applyLogPipeline(
		[]string{"2026-11-10T14:15:25Z INFO password=should-block confidential-context"},
		nil, cfg, logPipelineState{}, logCounters{}, now,
	)
	if len(lines) != 0 || !pipeline.HeldOpen {
		t.Fatalf("expected held entry: %q %+v", lines, pipeline)
	}
	path := filepath.Join(t.TempDir(), "agent-state.json")
	store := &logStateStore{}
	st, err := store.service(path, "held")
	if err != nil {
		t.Fatal(err)
	}
	st.Pipeline, st.Counters = pipeline, counters
	if err := store.save(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(logStatePath(path))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "should-block") || !strings.Contains(string(data), "heldRawEncrypted") {
		t.Fatalf("raw filter input was not encrypted: %s", data)
	}
	restarted := &logStateStore{}
	st, err = restarted.service(path, "held")
	if err != nil {
		t.Fatal(err)
	}
	lines, _, _, counters = applyLogPipeline(nil, nil, cfg, st.Pipeline, st.Counters, now.Add(3*time.Second))
	if len(lines) != 0 || counters.Excluded != 1 {
		t.Fatalf("raw exclude was bypassed after restart: %q %+v", lines, counters)
	}
	if err := os.Remove(logStatePath(path) + ".key"); err != nil {
		t.Fatal(err)
	}
	if _, err := (&logStateStore{}).service(path, "held"); err == nil {
		t.Fatal("missing encryption key must fail explicitly")
	}
}

func TestMultilineCapDoesNotBypassRawExclusion(t *testing.T) {
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_EXCLUDE", "drop-after-cap")
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_ENTRY_MAX_LINES", "2")
	cfg, err := loadLogPipelineConfig("rspamd", "cap")
	if err != nil {
		t.Fatal(err)
	}
	lines, _, _, counters := applyLogPipeline([]string{
		"2026-11-10T14:15:25Z ERROR private-context",
		"  first continuation",
		"  drop-after-cap",
		"  last continuation",
		"2026-11-10T14:15:26Z INFO next",
	}, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	if len(lines) != 0 || counters.Excluded != 4 {
		t.Fatalf("capped excluded entry or continuation escaped: %q %+v", lines, counters)
	}
}

func TestMultilineMasksApplyAfterAssembly(t *testing.T) {
	t.Run("replacement across lines", func(t *testing.T) {
		t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK", `begin\n  cross-line-secret=>[HIDDEN]`)
		cfg, err := loadLogPipelineConfig("rspamd", "multiline-mask")
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		lines, _, pipeline, counters := applyLogPipeline([]string{
			"2026-11-10T14:15:25Z INFO begin",
			"  cross-line-secret",
		}, nil, cfg, logPipelineState{}, logCounters{}, now)
		if len(lines) != 0 {
			t.Fatalf("unfinished entry was not held: %q", lines)
		}
		path := filepath.Join(t.TempDir(), "state.json")
		store := &logStateStore{}
		st, err := store.service(path, "multiline-mask")
		if err != nil {
			t.Fatal(err)
		}
		st.Pipeline, st.Counters = pipeline, counters
		if err := store.save(); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(logStatePath(path))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "cross-line-secret") || !strings.Contains(string(data), "heldLineEncrypted") {
			t.Fatalf("incomplete multiline mask was persisted in plaintext: %s", data)
		}
		restarted, err := (&logStateStore{}).service(path, "multiline-mask")
		if err != nil {
			t.Fatal(err)
		}
		lines, _, _, counters = applyLogPipeline([]string{"2026-11-10T14:15:26Z INFO next"},
			nil, cfg, restarted.Pipeline, restarted.Counters, now)
		if len(lines) != 1 || lines[0] != "2026-11-10T14:15:25Z INFO [HIDDEN]" || counters.Masked != 2 {
			t.Fatalf("cross-line rule was not applied: %q %+v", lines, counters)
		}
	})
	for _, name := range []string{"overlapping mask", "line cap"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK", `context-secret\n  password=[^\n]+=>[HIDDEN]`)
			if name == "line cap" {
				t.Setenv("ROBIN_AGENT_RSPAMD_LOG_ENTRY_MAX_LINES", "1")
			}
			cfg, err := loadLogPipelineConfig("rspamd", "multiline-mask")
			if err != nil {
				t.Fatal(err)
			}
			lines, _, _, _ := applyLogPipeline([]string{
				"2026-11-10T14:15:25Z INFO context-secret",
				"  password=value-secret",
				"2026-11-10T14:15:26Z INFO next",
			}, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
			if len(lines) != 1 || lines[0] != "2026-11-10T14:15:25Z INFO [HIDDEN]" {
				t.Fatalf("partial multiline match escaped masking: %q", lines)
			}
		})
	}
	t.Run("overlapping authentication", func(t *testing.T) {
		t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK_PRESETS", "auth")
		t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK", `context-secret\n  AUTH LOGIN\n  cGFzc3dvcmQ==>[HIDDEN]`)
		cfg, err := loadLogPipelineConfig("rspamd", "multiline-auth")
		if err != nil {
			t.Fatal(err)
		}
		lines, _, _, _ := applyLogPipeline([]string{
			"2026-11-10T14:15:25Z INFO context-secret",
			"  AUTH LOGIN",
			"  cGFzc3dvcmQ=",
			"2026-11-10T14:15:26Z INFO next",
		}, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
		if len(lines) != 1 || lines[0] != "[REDACTED]" {
			t.Fatalf("overlapping authentication mask leaked context: %q", lines)
		}
	})
}

func TestInterleavedAuthLoginExchangesRemainMasked(t *testing.T) {
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK_PRESETS", "auth")
	cfg, err := loadLogPipelineConfig("rspamd", "interleaved-auth")
	if err != nil {
		t.Fatal(err)
	}
	lines, _, state, _ := applyLogPipeline([]string{
		"AUTH LOGIN", "AUTH LOGIN",
		"dXNlckE=", "dXNlckI=", "cGFzc0E=",
		"235 authenticated", "cGFzc0I=", "235 authenticated",
		"YmluYXJ5AA==",
	}, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	text := strings.Join(lines, "\n")
	for _, secret := range []string{"dXNlckE=", "dXNlckI=", "cGFzc0E=", "cGFzc0I=", "YmluYXJ5AA=="} {
		if strings.Contains(text, secret) {
			t.Fatalf("interleaved authentication payload escaped: %q", lines)
		}
	}
	if state.LoginInFlight != 0 || state.LoginRemaining != 0 {
		t.Fatalf("interleaved authentication was not completed: %+v", state)
	}
}

func TestOversizedMultilineEntryIsDiscardedWithoutFilters(t *testing.T) {
	cfg, err := loadLogPipelineConfig("rspamd", "overflow")
	if err != nil {
		t.Fatal(err)
	}
	lines, _, _, counters := applyLogPipeline([]string{
		"2026-11-10T14:15:25Z INFO " + strings.Repeat("x", logRawEntryMaxBytes),
		"2026-11-10T14:15:26Z INFO next",
	}, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	if len(lines) != 0 || counters.Excluded != 1 || counters.Truncated != 1 {
		t.Fatalf("oversized entry was not safely discarded: %q %+v", lines, counters)
	}
}

func TestHeldEntryIsRedactedWhenMaskConfigurationChanges(t *testing.T) {
	cfg, err := loadLogPipelineConfig("rspamd", "mask-change")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	_, _, state, counters := applyLogPipeline([]string{"2026-11-10T14:15:25Z INFO private-value"},
		nil, cfg, logPipelineState{}, logCounters{}, now)
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK", `private-value=>[HIDDEN]`)
	cfg, err = loadLogPipelineConfig("rspamd", "mask-change")
	if err != nil {
		t.Fatal(err)
	}
	lines, _, _, _ := applyLogPipeline([]string{"2026-11-10T14:15:26Z INFO next"},
		nil, cfg, state, counters, now)
	if len(lines) != 1 || lines[0] != "[REDACTED]" {
		t.Fatalf("entry held under an older mask configuration escaped: %q", lines)
	}
}

func TestEmptyMaskReplacementDoesNotMisalignEntries(t *testing.T) {
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK", "^erase$=>")
	cfg, err := loadLogPipelineConfig("rspamd", "empty")
	if err != nil {
		t.Fatal(err)
	}
	lines, _, _, _ := applyLogPipeline([]string{"erase", "kept"}, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	if len(lines) != 1 || lines[0] != "kept" {
		t.Fatalf("empty replacement corrupted entries: %q", lines)
	}
}

func TestDefaultMasksHandleUnicodeAndEarlierReplacements(t *testing.T) {
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK", `inject=>password=created-secret`)
	cfg, err := loadLogPipelineConfig("rspamd", "mask-precheck")
	if err != nil {
		t.Fatal(err)
	}
	lines, _, _, counters := applyLogPipeline([]string{"pa\u017f\u017fword=unicode-secret", "inject"},
		nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	if len(lines) != 2 || strings.Contains(strings.Join(lines, "\n"), "unicode-secret") ||
		lines[1] != "password=[REDACTED]" || counters.Masked != 2 {
		t.Fatalf("default masking missed or double-counted a credential: %q %+v", lines, counters)
	}
}

func TestCustomMasksCannotBypassBuiltInCredentialMasking(t *testing.T) {
	tests := []struct {
		name, rule, input, secret string
	}{
		{"credential", `password=>renamed`, "password=private-value", "private-value"},
		{"authorization", `Authorization=>Header`, "Authorization: Basic private-value", "private-value"},
		{"smtp auth", `AUTH=>COMMAND`, "AUTH PLAIN cHJpdmF0ZS12YWx1ZQ==", "cHJpdmF0ZS12YWx1ZQ=="},
		{"imap login", `LOGIN=>CONNECT`, "a LOGIN alice private-value", "private-value"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK", tt.rule)
			cfg, err := loadLogPipelineConfig("rspamd", "mask-order")
			if err != nil {
				t.Fatal(err)
			}
			lines, _, _, _ := applyLogPipeline([]string{tt.input}, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
			if len(lines) != 1 || strings.Contains(lines[0], tt.secret) {
				t.Fatalf("custom mask bypassed built-in credential masking: %q", lines)
			}
		})
	}
}

func TestContainerPipelineKeepsStreamStateSeparate(t *testing.T) {
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_MASK_PRESETS", "auth")
	cfg, err := loadLogPipelineConfig("rspamd", "streams")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	entries, state, counters := processLogPipeline([]string{
		"[alpha] 2026-11-10T14:15:25Z ERROR alpha failure",
		"[bravo] 2026-11-10T14:15:26Z ERROR bravo failure",
		"[alpha]   at alpha.go:42",
		"[bravo] 2026-11-10T14:15:27Z INFO done",
	}, nil, []string{"id-a", "id-b", "id-a", "id-b"}, false, cfg, logPipelineState{}, logCounters{}, now)
	more, state, counters := processLogPipeline(nil, nil, nil, false, cfg, state, counters, now.Add(3*time.Second))
	entries = append(entries, more...)
	got, _, _ := shippedLogEntries(entries, counters)
	text := strings.Join(got, "\n---\n")
	if !strings.Contains(text, "alpha failure\n[alpha]   at alpha.go:42") || strings.Contains(text, "bravo failure\n[alpha]") {
		t.Fatalf("multiline entries crossed container identities: %q", got)
	}
	entries, state, counters = processLogPipeline([]string{
		"[alpha] AUTH LOGIN", "[bravo] unrelated first", "[bravo] unrelated second",
		"[alpha] 334 VXNlcm5hbWU6", "[alpha] dXNlcg==",
		"[alpha] 334 UGFzc3dvcmQ6", "[alpha] cGFzc3dvcmQ=",
	}, nil, []string{"id-a", "id-b", "id-b", "id-a", "id-a", "id-a", "id-a"},
		false, cfg, logPipelineState{}, logCounters{}, now)
	more, _, counters = processLogPipeline(nil, nil, nil, false, cfg, state, counters, now.Add(3*time.Second))
	got, _, _ = shippedLogEntries(append(entries, more...), counters)
	text = strings.Join(got, "\n")
	if strings.Contains(text, "dXNlcg==") || strings.Contains(text, "cGFzc3dvcmQ=") ||
		!strings.Contains(text, "unrelated first") || !strings.Contains(text, "unrelated second") {
		t.Fatalf("authentication state crossed container identities: %q", got)
	}
}

func TestSourceFilterAndSyslogPriority(t *testing.T) {
	t.Setenv("ROBIN_AGENT_POSTFIX_LOG_INCLUDE", "WARN")
	cfg, err := loadLogPipelineConfig("postfix", "shared")
	if err != nil {
		t.Fatal(err)
	}
	lines, _, _, _ := applyLogPipeline([]string{"other WARN", "postfix/smtp WARN"}, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	if len(lines) != 1 || lines[0] != "postfix/smtp WARN" {
		t.Fatalf("source filter must constrain additional include rules: %q", lines)
	}
	if level := lineLogLevel("<135>message"); level != 7 {
		t.Fatalf("syslog facility was not removed: level=%d", level)
	}
	t.Setenv("ROBIN_AGENT_POSTFIX_LOG_CONTAINER", "postal-*")
	cfg, err = loadLogPipelineConfig("postfix", "dedicated")
	if err != nil || cfg.sourceFilter != "" {
		t.Fatalf("dedicated container inherited shared-file filter: %+v %v", cfg, err)
	}
}

func TestFractionalRateHasUsableDefaultBurst(t *testing.T) {
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_RATE_PER_SECOND", "0.5")
	cfg, err := loadLogPipelineConfig("rspamd", "fractional")
	if err != nil || cfg.burst != 1 {
		t.Fatalf("fractional rate cannot deliver: %+v %v", cfg, err)
	}
	lines, _, _, _ := applyLogPipeline([]string{"INFO retained"}, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
	if len(lines) != 1 || lines[0] != "INFO retained" {
		t.Fatalf("fractional rate dropped its initial token: %q", lines)
	}
	t.Setenv("ROBIN_AGENT_RSPAMD_LOG_RATE_BURST", "0.5")
	if _, err := loadLogPipelineConfig("rspamd", "fractional"); err == nil {
		t.Fatal("an explicit burst smaller than one must be rejected")
	}
}
func TestLogPipelineMasksCredentialsEmailAndAuth(t *testing.T) {
	cfg := logPipelineConfig{
		authMask:  true,
		emailMask: true,
		masks: []logMaskRule{
			{pattern: authorizationPattern, replacement: "${1}[REDACTED]"},
			{pattern: credentialPattern, replacement: "$1$2[REDACTED]"},
			{pattern: bearerPattern, replacement: "${1}[REDACTED]"},
			{pattern: authPlainPattern, replacement: "${1}[REDACTED]"},
			{pattern: emailPattern, replacement: "[REDACTED]"},
		},
		minimumLevel: -1,
		entryStart:   regexp.MustCompile(`^`),
		entryLines:   10,
		entryBytes:   4096,
	}
	lines := []string{
		"password=hunter2",
		"Authorization: Bearer abc.def.ghi",
		"AUTH PLAIN dXNlcjpwYXNzd29yZA==",
		"235 authenticated",
		"AUTH LOGIN",
		"dXNlcg==",
		"cGFzc3dvcmQ=",
		"235 authenticated",
		"mail someone@example.com",
		"AUTH LOGIN",
	}
	var state logPipelineState
	now := time.Now().Add(3 * time.Second)
	got, _, state, counters := applyLogPipeline(lines, nil, cfg, state, logCounters{}, now)
	if strings.Contains(strings.Join(got, "\n"), "hunter2") ||
		strings.Contains(strings.Join(got, "\n"), "abc.def.ghi") ||
		strings.Contains(strings.Join(got, "\n"), "dXNlc") ||
		strings.Contains(strings.Join(got, "\n"), "someone@example.com") {
		t.Fatalf("pipeline leaked a secret: %q", got)
	}
	if strings.Contains(state.HeldLine, "someone@example.com") || counters.Masked < 5 {
		t.Fatalf("expected all input lines sanitized before persistence: state=%+v counters=%+v", state, counters)
	}
	matches := emailPattern.FindAllString(strings.Join(got, "\n"), -1)
	if len(matches) != 1 || !strings.HasSuffix(matches[0], "@example.com") {
		t.Fatalf("email domain must remain correlatable: %q", got)
	}
}

func TestAuthorizationHeaderMaskIncludesBearerToken(t *testing.T) {
	cfg := logPipelineConfig{
		minimumLevel: -1,
		entryStart:   regexp.MustCompile(`^`),
		entryLines:   10,
		entryBytes:   4096,
		masks: []logMaskRule{
			{pattern: authorizationPattern, replacement: "${1}[REDACTED]"},
			{pattern: credentialPattern, replacement: "$1$2[REDACTED]"},
			{pattern: bearerPattern, replacement: "${1}[REDACTED]"},
		},
	}
	cfg.entryStart = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`)
	lines, _, _, _ := applyLogPipeline(
		[]string{"Authorization: Bearer abc.def.ghi"}, nil, cfg, logPipelineState{}, logCounters{}, time.Now().Add(3*time.Second),
	)
	if len(lines) != 1 || strings.Contains(lines[0], "abc.def.ghi") || !strings.Contains(lines[0], "[REDACTED]") {
		t.Fatalf("authorization header leaked its bearer token: %q", lines)
	}
	actual, _, _, _ := applyLogPipeline(
		[]string{"Authorization: Bearer abc.def.ghi"}, nil, cfg, logPipelineState{}, logCounters{}, time.Now(),
	)
	if len(actual) != 1 || strings.Contains(actual[0], "abc.def.ghi") || !strings.Contains(actual[0], "[REDACTED]") {
		t.Fatalf("authorization header leaked its actual bearer token: %q", actual)
	}
	secret, _, _, _ := applyLogPipeline(
		[]string{strings.Join([]string{"Authorization:", "Bearer", "abc.def.ghi"}, " ")},
		nil, cfg, logPipelineState{}, logCounters{}, time.Now(),
	)
	if len(secret) != 1 || strings.Contains(secret[0], "abc.def.ghi") || !strings.Contains(secret[0], "[REDACTED]") {
		t.Fatalf("authorization header leaked a bearer token: %q", secret)
	}
}

func TestLogPipelineMergesEntryAcrossBatchBoundary(t *testing.T) {
	cfg := logPipelineConfig{
		minimumLevel: -1,
		entryStart:   regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`),
		entryLines:   10,
		entryBytes:   4096,
	}
	first, _, state, _ := applyLogPipeline(
		[]string{"2026-11-10 14:15:25 ERROR failed"},
		[]string{"2026-11-10T14:15:25Z"}, cfg, logPipelineState{}, logCounters{}, time.Now(),
	)
	if len(first) != 0 || state.HeldLine == "" {
		t.Fatalf("partial entry should be held: lines=%q state=%+v", first, state)
	}
	second, times, state, _ := applyLogPipeline(
		[]string{"  at app.rb:42", "2026-11-10 14:15:26 INFO recovered"},
		[]string{"", "2026-11-10T14:15:26Z"}, cfg, state, logCounters{}, time.Now(),
	)
	if len(second) != 1 || second[0] != "2026-11-10 14:15:25 ERROR failed\n  at app.rb:42" ||
		len(times) != 1 || times[0] != "2026-11-10T14:15:25Z" || state.HeldLine == "" {
		t.Fatalf("entry did not merge across batches: lines=%q times=%q state=%+v", second, times, state)
	}
}

func TestLogPipelineKeepsHeldEntryWhileBacklogRemains(t *testing.T) {
	cfg := logPipelineConfig{
		minimumLevel: -1,
		entryStart:   regexp.MustCompile(`^START`),
		entryLines:   10,
		entryBytes:   4096,
	}
	now := time.Now()
	_, state, counters := processLogPipelineWithHistory(
		[]string{"START ERROR failed"}, nil, []string{"worker"}, nil, false,
		cfg, logPipelineState{}, logCounters{}, now, true, nil)
	entries, state, counters := processLogPipelineWithHistory(
		[]string{"INFO other"}, nil, []string{"other"}, nil, false,
		cfg, state, counters, now.Add(3*time.Second), true, nil)
	if len(entries) != 1 || entries[0].line != "INFO other" || !state.Streams["worker"].HeldOpen {
		t.Fatalf("an entry timed out while unread records remained: %+v", entries)
	}
	entries, _, _ = processLogPipelineWithHistory(
		[]string{"  at worker.rb:42", "START INFO recovered"}, nil,
		[]string{"worker", "worker"}, nil, false, cfg, state, counters, now.Add(4*time.Second), false, nil)
	if len(entries) != 1 || entries[0].line != "START ERROR failed\n  at worker.rb:42" {
		t.Fatalf("continuation was split from its held entry: %+v", entries)
	}
}

func TestLogPipelineRateLimitKeepsHighestSeverityAndSummarizes(t *testing.T) {
	cfg := logPipelineConfig{
		rate:         2,
		burst:        2,
		minimumLevel: -1,
		entryStart:   regexp.MustCompile(`^`),
		entryLines:   10,
		entryBytes:   4096,
	}

	now := time.Now().Add(3 * time.Second)
	lines, _, _, counters := applyLogPipeline(
		[]string{"DEBUG d", "INFO i", "WARN w", "ERROR e", "FATAL f", "TRACE marker"},
		nil, cfg, logPipelineState{}, logCounters{}, now,
	)
	if len(lines) != 3 || lines[0] != "ERROR e" || lines[1] != "FATAL f" ||
		!strings.Contains(lines[2], "3 lines dropped by rate limit") || counters.RateLimited != 3 {
		t.Fatalf("rate limiter did not prefer severity and summarize: lines=%q counters=%+v", lines, counters)
	}
}

func TestRateLimitUsesSeverityBeforeMaskingAndTruncation(t *testing.T) {
	tests := []struct {
		name       string
		lines      []string
		mask       *logMaskRule
		entryBytes int
		want       string
	}{
		{
			name:  "mask hides error",
			lines: []string{"DEBUG low", "ERROR high"},
			mask:  &logMaskRule{pattern: regexp.MustCompile(`ERROR`), replacement: "REDACTED"},
			want:  "REDACTED high",
		},
		{
			name:  "mask introduces error",
			lines: []string{"DEBUG low", "WARN high"},
			mask:  &logMaskRule{pattern: regexp.MustCompile(`DEBUG`), replacement: "ERROR"},
			want:  "WARN high",
		},
		{
			name:       "truncation hides error",
			lines:      []string{"DEBUG low", "long-prefix ERROR high"},
			entryBytes: 12,
			want:       "long-prefix ",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := logPipelineConfig{
				rate: 1, burst: 1, minimumLevel: -1,
				entryStart: regexp.MustCompile(`^START`),
				entryLines: 10, entryBytes: 4096,
			}
			if tt.mask != nil {
				cfg.masks, cfg.customMaskCount = []logMaskRule{*tt.mask}, 1
			}
			if tt.entryBytes > 0 {
				cfg.entryBytes = tt.entryBytes
			}
			lines, _, _, counters := applyLogPipeline(tt.lines, nil, cfg, logPipelineState{}, logCounters{}, time.Now())
			if len(lines) != 2 || lines[0] != tt.want || counters.RateLimited != 1 {
				t.Fatalf("rate priority did not use the original severity: lines=%q counters=%+v", lines, counters)
			}
		})
	}
}

func TestRateLimitCurrentClearsAfterRecovery(t *testing.T) {
	cfg := logPipelineConfig{
		rate: 1, burst: 1, minimumLevel: -1,
		entryStart: regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`),
		entryLines: 10, entryBytes: 4096,
	}
	now := time.Now()
	_, _, state, counters := applyLogPipeline([]string{"INFO first", "DEBUG dropped"},
		nil, cfg, logPipelineState{}, logCounters{}, now)
	if counters.RateLimited != 1 || counters.RateLimitedCurrent != 1 {
		t.Fatalf("rate-limited window was not reported: %+v", counters)
	}
	_, _, _, counters = applyLogPipeline(nil, nil, cfg, state, counters, now.Add(2*time.Second))
	if counters.RateLimited != 1 || counters.RateLimitedCurrent != 0 {
		t.Fatalf("rate-limit warning did not clear after recovery: %+v", counters)
	}
}

func TestRateLimitAccountsForTheCollectionWindow(t *testing.T) {
	cfg := logPipelineConfig{
		rate: 200, burst: 400, minimumLevel: -1,
		entryStart: regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`),
		entryLines: 10, entryBytes: 4096,
	}
	start := time.Now().UTC().Truncate(time.Second)
	now := start.Add(30 * time.Second)
	state := logPipelineState{Tokens: 0, LastRefill: start}
	lines, times := make([]string, 3750), make([]string, 3750)
	for i := range lines {
		lines[i] = "INFO retained"
		times[i] = start.Add(time.Duration(i/125+1) * time.Second).Format(time.RFC3339Nano)
	}
	got, _, _, counters := applyLogPipeline(lines, times, cfg, state, logCounters{}, now)
	if len(got) != len(lines) || counters.RateLimited != 0 {
		t.Fatalf("sustained traffic below the configured rate was dropped: %d / %d, %+v", len(got), len(lines), counters)
	}
	for i := range times {
		times[i] = now.Format(time.RFC3339Nano)
	}
	got, _, _, counters = applyLogPipeline(lines, times, cfg, state, logCounters{}, now)
	if len(got) != 401 || counters.RateLimited != uint64(len(lines)-400) {
		t.Fatalf("a single burst exceeded its capacity: %d / %d, %+v", len(got), len(lines), counters)
	}
	got, _, _, counters = applyLogPipeline(lines, nil, cfg, state, logCounters{}, now)
	if len(got) != len(lines) || counters.RateLimited != 0 {
		t.Fatalf("untimestamped sustained traffic was limited to one burst: %d / %d, %+v", len(got), len(lines), counters)
	}
}

func TestRateLimitCapsCreditAfterIdleAndPreservesPriority(t *testing.T) {
	cfg := logPipelineConfig{
		rate: 200, burst: 400, minimumLevel: -1,
		entryStart: regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`),
		entryLines: 10, entryBytes: 4096,
	}
	start := time.Now().UTC().Truncate(time.Second)
	now := start.Add(30 * time.Second)
	lines := []string{"DEBUG before idle"}
	times := []string{start.Format(time.RFC3339Nano)}
	for range 400 {
		lines, times = append(lines, "WARN spike"), append(times, now.Format(time.RFC3339Nano))
	}
	for range 600 {
		lines, times = append(lines, "DEBUG spike"), append(times, now.Format(time.RFC3339Nano))
	}
	got, _, state, counters := applyLogPipeline(lines, times, cfg,
		logPipelineState{Tokens: 400, LastRefill: start}, logCounters{}, now)
	output := strings.Join(got, "\n")
	if len(got) != 402 || counters.RateLimited != 600 ||
		strings.Count(output, "WARN spike") != 400 ||
		strings.Count(output, "DEBUG before idle") != 1 ||
		strings.Contains(output, "DEBUG spike") ||
		!strings.Contains(output, "600 lines dropped by rate limit") {
		t.Fatalf("idle credit exceeded the burst or displaced warnings: %d lines, %+v", len(got), counters)
	}
	got, _, state, counters = applyLogPipeline([]string{"WARN immediate"}, []string{now.Format(time.RFC3339Nano)},
		cfg, state, counters, now)
	if len(got) != 0 || counters.RateLimited != 601 {
		t.Fatalf("subsequent call reused spent tokens: %q %+v", got, counters)
	}
	later := now.Add(time.Second)
	got, _, _, counters = applyLogPipeline([]string{"WARN recovered"}, []string{later.Format(time.RFC3339Nano)},
		cfg, state, counters, later)
	if !strings.Contains(strings.Join(got, "\n"), "WARN recovered") || counters.RateLimited != 601 {
		t.Fatalf("rate limiter did not refill after the spike: %q %+v", got, counters)
	}
}

func TestRateLimitHandlesFractionalRefills(t *testing.T) {
	cfg := logPipelineConfig{rate: 0.5, burst: 2}
	start := time.Now().UTC().Truncate(time.Second)
	entries := []logEntry{
		{line: "INFO first", time: start.Format(time.RFC3339Nano)},
		{line: "INFO too soon", time: start.Add(time.Second).Format(time.RFC3339Nano)},
		{line: "WARN second", time: start.Add(2 * time.Second).Format(time.RFC3339Nano)},
		{line: "WARN third", time: start.Add(4 * time.Second).Format(time.RFC3339Nano)},
	}
	out, state, counters := limitLogEntries(entries, cfg,
		logPipelineState{Tokens: 1, LastRefill: start}, logCounters{}, start.Add(4*time.Second))
	if len(out) != 4 || counters.RateLimited != 1 || state.Tokens != 0 ||
		!strings.HasPrefix(out[0].line, "INFO ") || out[1].line != "WARN second" || out[2].line != "WARN third" {
		t.Fatalf("fractional token bucket selected invalid entries: %+v %+v %+v", out, state, counters)
	}
}

func TestRateLimitCountsMultilineEntriesWithoutSplittingThem(t *testing.T) {
	cfg := logPipelineConfig{rate: 1, burst: 2}
	now := time.Now().UTC().Truncate(time.Second)
	entries := []logEntry{
		{line: "INFO lower priority", time: now.Format(time.RFC3339Nano)},
		{line: "WARN stack trace\n  at worker.rb:42", time: now.Format(time.RFC3339Nano)},
	}
	out, state, counters := limitLogEntries(entries, cfg, logPipelineState{}, logCounters{}, now)
	if len(out) != 2 || out[0].line != entries[1].line || state.Tokens != 0 ||
		counters.RateLimited != 1 || !strings.Contains(out[1].line, "1 lines dropped by rate limit") {
		t.Fatalf("multiline entries did not consume their full line budget: %+v %+v %+v", out, state, counters)
	}
	_, _, shipped := shippedLogEntries(out, counters)
	if shipped.Shipped != 3 {
		t.Fatalf("multiline output was not counted as physical lines: %+v", shipped)
	}

	entries[1].line += "\n  at caller.rb:8"
	out, _, counters = limitLogEntries(entries, cfg, logPipelineState{}, logCounters{}, now)
	if len(out) != 2 || out[0].line != entries[0].line || counters.RateLimited != 3 ||
		!strings.Contains(out[1].line, "3 lines dropped by rate limit") {
		t.Fatalf("oversized multiline entry was split or miscounted: %+v %+v", out, counters)
	}
}

func TestRateLimitHandlesLargeBurstWithoutInventingTokens(t *testing.T) {
	cfg := logPipelineConfig{rate: 0.5, burst: 1e20}
	start := time.Now().UTC().Truncate(time.Second)
	entries := []logEntry{
		{line: "WARN before refill", time: start.Format(time.RFC3339Nano)},
		{line: "DEBUG before refill", time: start.Add(time.Second).Format(time.RFC3339Nano)},
	}
	out, state, counters := limitLogEntries(entries, cfg,
		logPipelineState{Tokens: 0, LastRefill: start}, logCounters{}, start.Add(time.Second))
	if len(out) != 1 || !strings.Contains(out[0].line, "2 lines dropped by rate limit") ||
		state.Tokens != 0.5 || counters.RateLimited != 2 {
		t.Fatalf("large burst created tokens that had not refilled: %+v %+v %+v", out, state, counters)
	}
}

func TestLogPipelineCountsExcludedMultilineEntries(t *testing.T) {
	cfg := logPipelineConfig{
		exclude:      []logPattern{{text: "drop"}},
		minimumLevel: -1,
		entryStart:   regexp.MustCompile(`^START`),
		entryLines:   10,
		entryBytes:   4096,
	}
	_, _, _, counters := applyLogPipeline(
		[]string{"START drop", "  trace", "START keep"}, nil,
		cfg, logPipelineState{}, logCounters{}, time.Now())
	if counters.Read != 3 || counters.Excluded != 2 {
		t.Fatalf("excluded multiline entry was not counted by line: %+v", counters)
	}
}

func TestRateLimitPreservesLowerPriorityWhenHigherPriorityCanMove(t *testing.T) {
	cfg := logPipelineConfig{rate: 0.25, burst: 2}
	start := time.Now().UTC().Truncate(time.Second)
	offsets := []int{0, 2, 4, 5, 5, 5, 8, 9, 10}
	levels := []string{"INFO", "WARN", "INFO", "INFO", "WARN", "WARN", "INFO", "DEBUG", "DEBUG"}
	entries := make([]logEntry, len(offsets))
	for i, offset := range offsets {
		entries[i] = logEntry{
			line: fmt.Sprintf("%s item-%d", levels[i], i),
			time: start.Add(time.Duration(offset) * time.Second).Format(time.RFC3339Nano),
		}
	}
	out, _, counters := limitLogEntries(entries, cfg,
		logPipelineState{Tokens: 1, LastRefill: start}, logCounters{}, start.Add(10*time.Second))
	var warnings, infos, debug int
	for _, entry := range out {
		switch {
		case strings.HasPrefix(entry.line, "WARN "):
			warnings++
		case strings.HasPrefix(entry.line, "INFO "):
			infos++
		case strings.HasPrefix(entry.line, "DEBUG "):
			debug++
		}
	}
	if warnings != 2 || infos != 1 || debug != 0 || counters.RateLimited != 6 {
		t.Fatalf("severity priority lost a feasible INFO entry: %+v, %+v", out, counters)
	}
}

func TestRateLimitMaximizesSeverityPriority(t *testing.T) {
	random := rand.New(rand.NewSource(108))
	start := time.Now().UTC().Truncate(time.Second)
	levels := []string{"DEBUG", "INFO", "WARN", "ERROR"}
	for scenario := 0; scenario < 250; scenario++ {
		cfg := logPipelineConfig{
			rate:  []float64{0.25, 0.5, 1, 2.5}[random.Intn(4)],
			burst: []float64{1, 1.5, 2, 3}[random.Intn(4)],
		}
		initial := float64(random.Intn(int(cfg.burst*4)+1)) / 4
		offsets := make([]int, 9)
		for i := range offsets {
			offsets[i] = random.Intn(41)
		}
		sort.Ints(offsets)
		entries := make([]logEntry, len(offsets))
		for i, offset := range offsets {
			entries[i] = logEntry{
				line: fmt.Sprintf("%s item-%d%s", levels[random.Intn(len(levels))], i, strings.Repeat("\n  trace", random.Intn(3))),
				time: start.Add(time.Duration(offset) * 250 * time.Millisecond).Format(time.RFC3339Nano),
			}
		}
		type counts [6]int
		compare := func(a, b counts) int {
			for i := range a {
				if a[i] != b[i] {
					return a[i] - b[i]
				}
			}
			return 0
		}
		var best counts
		for mask := 0; mask < 1<<len(entries); mask++ {
			tokens, last, possible := initial, start, true
			var score counts
			for i, entry := range entries {
				at, err := time.Parse(time.RFC3339Nano, entry.time)
				if err != nil {
					t.Fatal(err)
				}
				tokens = minFloat(cfg.burst, tokens+at.Sub(last).Seconds()*cfg.rate)
				last = at
				if mask&(1<<i) != 0 {
					cost := logLineCount(entry.line)
					if tokens < float64(cost)-1e-9 {
						possible = false
						break
					}
					tokens -= float64(cost)
					score[4-severityRank(entry.line)] += cost
				}
			}
			if possible && compare(score, best) > 0 {
				best = score
			}
		}
		out, _, _ := limitLogEntries(entries, cfg,
			logPipelineState{Tokens: initial, LastRefill: start}, logCounters{}, start.Add(10*time.Second))
		var got counts
		for _, entry := range out {
			if strings.Contains(entry.line, " item-") {
				got[4-severityRank(entry.line)] += logLineCount(entry.line)
			}
		}
		if got != best {
			t.Fatalf("scenario %d did not maximize priority: got %v, want %v; entries=%+v, initial=%v, cfg=%+v",
				scenario, got, best, entries, initial, cfg)
		}
	}
}

func TestRateLimitReconstructsSelectionsAcrossCheckpoints(t *testing.T) {
	cfg := logPipelineConfig{rate: 2.5, burst: 2}
	start := time.Now().UTC().Truncate(time.Second)
	offsets := []time.Duration{0, 200, 400, 500, 500, 500, 800, 900, 1000}
	levels := []string{"INFO", "WARN", "INFO", "INFO", "WARN", "WARN", "INFO", "DEBUG", "DEBUG"}
	var entries []logEntry
	for group := range 15 {
		for i, offset := range offsets {
			entries = append(entries, logEntry{
				line: fmt.Sprintf("%s item-%d-%d", levels[i], group, i),
				time: start.Add(time.Duration(group)*2*time.Second + offset*time.Millisecond).Format(time.RFC3339Nano),
			})
		}
	}
	out, _, counters := limitLogEntries(entries, cfg,
		logPipelineState{Tokens: 2, LastRefill: start}, logCounters{}, start.Add(29*time.Second))
	var warnings, infos, debug int
	for _, entry := range out {
		switch {
		case strings.HasPrefix(entry.line, "WARN "):
			warnings++
		case strings.HasPrefix(entry.line, "INFO "):
			infos++
		case strings.HasPrefix(entry.line, "DEBUG "):
			debug++
		}
	}
	if warnings != 30 || infos != 30 || debug != 0 || counters.RateLimited != 75 {
		t.Fatalf("checkpoint reconstruction changed the optimal selection: warn=%d info=%d debug=%d, %+v",
			warnings, infos, debug, counters)
	}
}

func TestRateLimitSelectedEntriesObeyTokenBucket(t *testing.T) {
	random := rand.New(rand.NewSource(42))
	start := time.Now().UTC().Truncate(time.Second)
	now := start.Add(30 * time.Second)
	for scenario := 0; scenario < 200; scenario++ {
		cfg := logPipelineConfig{
			rate:  []float64{0.25, 0.5, 1, 2.5}[random.Intn(4)],
			burst: float64(1 + random.Intn(4)),
		}
		initial := float64(random.Intn(int(cfg.burst*4)+1)) / 4
		offsets := make([]int, 20)
		for i := range offsets {
			offsets[i] = random.Intn(30001)
		}
		sort.Ints(offsets)
		entries := make([]logEntry, len(offsets))
		for i, offset := range offsets {
			level := []string{"DEBUG", "INFO", "WARN", "ERROR"}[random.Intn(4)]
			entries[i] = logEntry{
				line: fmt.Sprintf("%s item-%d", level, i),
				time: start.Add(time.Duration(offset) * time.Millisecond).Format(time.RFC3339Nano),
			}
		}
		out, state, _ := limitLogEntries(entries, cfg, logPipelineState{Tokens: initial, LastRefill: start}, logCounters{}, now)
		kept := make(map[string]bool, len(out))
		for _, entry := range out {
			kept[entry.line] = true
		}
		tokens, last := initial, start
		for _, entry := range entries {
			at, err := time.Parse(time.RFC3339Nano, entry.time)
			if err != nil {
				t.Fatal(err)
			}
			tokens = minFloat(cfg.burst, tokens+at.Sub(last).Seconds()*cfg.rate)
			last = at
			if kept[entry.line] {
				if tokens < 1-1e-8 {
					t.Fatalf("scenario %d exceeded its burst at %s: %v tokens", scenario, entry.line, tokens)
				}
				tokens--
			}
		}
		tokens = minFloat(cfg.burst, tokens+now.Sub(last).Seconds()*cfg.rate)
		if math.Abs(tokens-state.Tokens) > 1e-7 {
			t.Fatalf("scenario %d retained %v tokens, expected %v", scenario, state.Tokens, tokens)
		}
	}
}

func BenchmarkLogRateLimitOverBudget(b *testing.B) {
	start := time.Date(2026, 11, 10, 14, 15, 25, 0, time.UTC)
	entries := make([]logEntry, 15000)
	levels := []string{"DEBUG", "INFO", "WARN", "ERROR"}
	for i := range entries {
		entries[i] = logEntry{
			line: levels[i%len(levels)] + " fixture",
			time: start.Add(time.Duration(i) * 2 * time.Millisecond).Format(time.RFC3339Nano),
		}
	}
	cfg := logPipelineConfig{rate: 200, burst: 400}
	initial := logPipelineState{Tokens: 400, LastRefill: start}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		limitLogEntries(entries, cfg, initial, logCounters{}, start.Add(30*time.Second))
	}
	b.ReportMetric(500, "lines/s")
}

func BenchmarkLogPipelinePostalFixtures500LinesPerSecond(b *testing.B) {
	cfg := logPipelineConfig{
		include:      []logPattern{{text: "trace_id="}},
		masks:        []logMaskRule{{pattern: credentialPattern, replacement: "$1$2[REDACTED]"}},
		emailMask:    true,
		rate:         500,
		burst:        500,
		minimumLevel: -1,
		entryStart:   regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`),
		entryLines:   100,
		entryBytes:   64 << 10,
	}
	fixtures := []string{
		"2026-11-10 14:15:25 +0000 DEBUG  => 250 OK trace_id=QISVFILH component=smtp-server",
		"2026-11-10 14:15:25 +0000 DEBUG  <= Return-Path: someone@example.com trace_id=QISVFILH component=smtp-server",
		"2026-11-10 14:15:25 +0000 WARN   Detected line with invalid line ending trace_id=QISVFILH component=smtp-server",
		"2026-11-10 14:15:25 +0000 ERROR  mail delivery failed trace_id=QISVFILH component=worker thread=work96",
	}
	lines := make([]string, 500)
	times := make([]string, 500)
	for i := range lines {
		lines[i] = fixtures[i%len(fixtures)]
		times[i] = "2026-11-10T14:15:25Z"
	}
	b.ReportAllocs()
	now := time.Now()
	state := logPipelineState{}
	counters := logCounters{}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, state, counters = applyLogPipeline(lines, times, cfg, state, counters, now.Add(time.Duration(i+1)*time.Second))
	}
	b.ReportMetric(500, "lines/op")
	_ = state
	_ = counters
}
