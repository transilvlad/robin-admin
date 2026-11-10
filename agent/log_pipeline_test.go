package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

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
	if len(lines) != 0 || counters.Excluded != 1 {
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
	if len(lines) != 0 || counters.Excluded != 1 {
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
