package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"math"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type logPattern struct {
	text  string
	regex *regexp.Regexp
}

func (p logPattern) matches(value string) bool {
	if p.regex != nil {
		return p.regex.MatchString(value)
	}
	return strings.Contains(value, p.text)
}

type logMaskRule struct {
	pattern     *regexp.Regexp
	replacement string
}

type logPipelineConfig struct {
	sourceFilter    string
	include         []logPattern
	exclude         []logPattern
	masks           []logMaskRule
	customMaskCount int
	emailMask       bool
	authMask        bool
	minimumLevel    int
	entryStart      *regexp.Regexp
	entryLines      int
	entryBytes      int
	rate            float64
	burst           float64
}

type logStreamState struct {
	HeldLine          string    `json:"heldLine,omitempty"`
	HeldLineEncrypted string    `json:"heldLineEncrypted,omitempty"`
	HeldRaw           string    `json:"-"`
	HeldRawEncrypted  string    `json:"heldRawEncrypted,omitempty"`
	HeldTime          string    `json:"heldTime,omitempty"`
	HeldSince         time.Time `json:"heldSince,omitzero"`
	HeldOpen          bool      `json:"heldOpen,omitempty"`
	HeldLines         int       `json:"heldLines,omitempty"`
	HeldTruncated     bool      `json:"heldTruncated,omitempty"`
	HeldOverflow      bool      `json:"heldOverflow,omitempty"`
	HeldReset         bool      `json:"heldReset,omitempty"`
	HeldMaskConfig    string    `json:"heldMaskConfig,omitempty"`
	HeldRateWindow    uint64    `json:"heldRateWindow,omitempty"`
	LoginRemaining    int       `json:"loginRemaining,omitempty"`
	LoginChallenged   bool      `json:"loginChallenged,omitempty"`
	LoginInFlight     int       `json:"loginInFlight,omitempty"`
	LoginObserved     bool      `json:"loginObserved,omitempty"`
}

type logPipelineState struct {
	logStreamState
	Streams          map[string]logStreamState `json:"streams,omitempty"`
	Tokens           float64                   `json:"tokens,omitempty"`
	LastRefill       time.Time                 `json:"lastRefill,omitzero"`
	LastDropSummary  time.Time                 `json:"lastDropSummary,omitzero"`
	PendingRateDrops uint64                    `json:"pendingRateDrops,omitempty"`
	RateWindowSeq    uint64                    `json:"rateWindowSeq,omitempty"`
	RateWindows      []logRateWindow           `json:"rateWindows,omitempty"`
	rateWindow       uint64
}

type logRateWindow struct {
	ID           uint64                `json:"id"`
	End          time.Time             `json:"end"`
	FilterConfig string                `json:"filterConfig"`
	MaskConfig   string                `json:"maskConfig"`
	Entries      []pendingLogRateEntry `json:"entries,omitempty"`
}

type pendingLogRateEntry struct {
	Line        string `json:"line"`
	Time        string `json:"time,omitempty"`
	RawLines    int    `json:"rawLines"`
	MaskedLines uint64 `json:"maskedLines,omitempty"`
	RateRank    int    `json:"rateRank,omitempty"`
	HasRateRank bool   `json:"hasRateRank,omitempty"`
	Historical  bool   `json:"historical,omitempty"`
}

type logCounters struct {
	Read               uint64    `json:"read"`
	Excluded           uint64    `json:"excluded"`
	Masked             uint64    `json:"masked"`
	Truncated          uint64    `json:"truncated"`
	RateLimited        uint64    `json:"rateLimited"`
	RateLimitedCurrent uint64    `json:"rateLimitedCurrent"`
	Shipped            uint64    `json:"shipped"`
	BytesShipped       uint64    `json:"bytesShipped"`
	ReadLagMS          int64     `json:"readLagMs"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

var (
	ansiEscapePattern        = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`)
	emailPattern             = regexp.MustCompile(`(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`)
	authorizationPattern     = regexp.MustCompile(`(?i)(\bAuthorization\s*[:=]\s*).*`)
	credentialPattern        = regexp.MustCompile(`(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)\s*([=:])\s*("(?:\\.|[^"\\])*(?:\\)?(?:"|$)|'(?:\\.|[^'\\])*(?:\\)?(?:'|$)|[^\s,;}\]]+)`)
	credentialJSONPattern    = regexp.MustCompile(`(?i)("(?:authorization|proxy[_-]?authorization|password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)"\s*:\s*)("(?:\\.|[^"\\])*(?:\\)?(?:"|$)|[^\s,}\]]+)`)
	bearerPattern            = regexp.MustCompile(`(?i)\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*`)
	authPlainPattern         = regexp.MustCompile(`(?i)(\b(?:AUTH|AUTHENTICATE)\s+PLAIN\s+)[A-Za-z0-9+/_-]+={0,2}([^A-Za-z0-9+/_=-]|$)`)
	authPlainCommandPattern  = regexp.MustCompile(`(?i)\b(?:AUTH|AUTHENTICATE)\s+PLAIN\b`)
	imapLoginPattern         = regexp.MustCompile(`(?i)(\bLOGIN\s+)(?:"(?:\\.|[^"\\])*"|[^"\s]\S*)(\s+)(?:"(?:\\.|[^"\\])*(?:\\)?(?:"|$)|[^"\s]\S*)`)
	imapIncompletePattern    = regexp.MustCompile(`(?i)(\bLOGIN\s+)(?:"(?:\\.|[^"\\])*(?:\\)?$|[^"\s]\S*\s*$)`)
	authLoginPattern         = regexp.MustCompile(`(?i)\b(?:AUTH|AUTHENTICATE)\s+LOGIN\b`)
	authLoginInitialPattern  = regexp.MustCompile(`(?i)(\b(?:AUTH|AUTHENTICATE)\s+LOGIN\s+)[A-Za-z0-9+/_-]+={0,2}([^A-Za-z0-9+/_=-]|$)`)
	authChallengePattern     = regexp.MustCompile(`(?:^|\s)334(?:[ -]|$)`)
	authResultPattern        = regexp.MustCompile(`(?i)(?:^|\s)(?:235|4[0-9]{2}|5[0-9]{2}|\+OK|-ERR|[A-Za-z0-9._-]+\s+(?:OK|NO|BAD))(?:[ -]|$)`)
	authPayloadPattern       = regexp.MustCompile(`^[A-Za-z0-9+/_-]{2,}={0,2}$`)
	authClientPayloadPattern = regexp.MustCompile(`(?:^|\s)(?:<=|[Cc]:)\s*([A-Za-z0-9+/_-]{2,}={0,2})(?:\s|$)`)
	levelPattern             = regexp.MustCompile(`(?i)(?:^|[\s\[])(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)(?:[\s\]:]|$)`)
	syslogPriPattern         = regexp.MustCompile(`^(?:\[[^\]]+\]\s*)?<([0-9]{1,3})>`)
	journalPriPattern        = regexp.MustCompile(`(?i)\bPRIORITY\s*=\s*([0-7])\b`)
)

func loadLogPipelineConfig(serviceType, serviceID string) (logPipelineConfig, error) {
	var cfg logPipelineConfig
	source, _ := resolveLogSource(serviceType, serviceID)
	cfg.sourceFilter = source.filter
	prefixes := []string{
		"ROBIN_AGENT_" + strings.ToUpper(serviceType) + "_LOG_",
		"ROBIN_AGENT_LOG_" + envKey(serviceID) + "_",
	}
	value := func(suffix string) string {
		for i := len(prefixes) - 1; i >= 0; i-- {
			if v := strings.TrimSpace(os.Getenv(prefixes[i] + suffix)); v != "" {
				return v
			}
		}
		return ""
	}
	// FILTER remains the simple substring include form. New configurations
	// should use INCLUDE / EXCLUDE, whose entries may be prefixed with re:.
	var err error
	if cfg.include, err = parseLogPatterns(cfg.include, value("INCLUDE")); err != nil {
		return cfg, fmt.Errorf("invalid log include rule: %w", err)
	}
	if cfg.exclude, err = parseLogPatterns(nil, value("EXCLUDE")); err != nil {
		return cfg, fmt.Errorf("invalid log exclude rule: %w", err)
	}
	if cfg.masks, err = parseLogMasks(value("MASK")); err != nil {
		return cfg, fmt.Errorf("invalid log mask rule: %w", err)
	}
	cfg.customMaskCount = len(cfg.masks)
	presets := splitLogConfigList(value("MASK_PRESETS"))
	for _, preset := range presets {
		switch strings.ToLower(preset) {
		case "email", "auth", "tokens":
		default:
			return cfg, fmt.Errorf("unknown log mask preset %q", preset)
		}
	}
	cfg.emailMask = slicesContains(presets, "email")
	cfg.authMask = true
	// Authentication and credential patterns are always enabled; the tokens
	// preset adds token-looking forms beyond the required credentials.
	if cfg.emailMask {
		cfg.masks = append(cfg.masks, logMaskRule{pattern: emailPattern, replacement: "[REDACTED]"})
	}
	cfg.masks = append(cfg.masks,
		logMaskRule{pattern: authorizationPattern, replacement: "${1}[REDACTED]"},
		logMaskRule{pattern: credentialJSONPattern, replacement: `${1}"[REDACTED]"`},
		logMaskRule{pattern: credentialPattern, replacement: "$1$2[REDACTED]"},
		logMaskRule{pattern: bearerPattern, replacement: "${1}[REDACTED]"},
	)
	if slicesContains(presets, "tokens") {
		cfg.masks = append(cfg.masks, logMaskRule{
			pattern:     regexp.MustCompile(`(?i)\b(?:sk|ghp|gho|xox[baprs])-?[A-Za-z0-9_-]{16,}\b`),
			replacement: "[REDACTED]",
		})
	}
	if cfg.authMask {
		cfg.masks = append(cfg.masks,
			logMaskRule{pattern: authPlainPattern, replacement: "${1}[REDACTED]${2}"},
			logMaskRule{pattern: imapIncompletePattern, replacement: "${1}[REDACTED]"},
			logMaskRule{pattern: imapLoginPattern, replacement: "${1}[REDACTED]${2}[REDACTED]"},
		)
	}
	minimumLevel := value("MIN_LEVEL")
	cfg.minimumLevel = parseLogLevel(minimumLevel)
	if minimumLevel != "" && cfg.minimumLevel < 0 {
		return cfg, fmt.Errorf("unknown minimum log level %q", minimumLevel)
	}
	cfg.entryStart = regexp.MustCompile(`^(?:\[[^\]]+\]\s*)?\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`)
	if start := value("ENTRY_STARTS_WITH"); start != "" {
		cfg.entryStart, err = regexp.Compile(start)
		if err != nil {
			return cfg, fmt.Errorf("invalid entry-start regex: %w", err)
		}
	}
	if maxLines := value("ENTRY_MAX_LINES"); maxLines != "" {
		cfg.entryLines, err = strconv.Atoi(maxLines)
		if err != nil || cfg.entryLines < 1 {
			return cfg, fmt.Errorf("ENTRY_MAX_LINES must be a positive integer")
		}
	} else {
		cfg.entryLines = 100
	}
	if maxBytes := value("ENTRY_MAX_BYTES"); maxBytes != "" {
		cfg.entryBytes, err = strconv.Atoi(maxBytes)
		if err != nil || cfg.entryBytes < 1 {
			return cfg, fmt.Errorf("ENTRY_MAX_BYTES must be a positive integer")
		}
	} else {
		cfg.entryBytes = 64 << 10
	}
	if rate := value("RATE_PER_SECOND"); rate != "" {
		cfg.rate, err = strconv.ParseFloat(rate, 64)
		if err != nil {
			return cfg, fmt.Errorf("invalid log rate %q", rate)
		}
	}
	if burst := value("RATE_BURST"); burst != "" {
		cfg.burst, err = strconv.ParseFloat(burst, 64)
		if err != nil {
			return cfg, fmt.Errorf("invalid log burst %q", burst)
		}
	}
	if cfg.rate < 0 || cfg.burst < 0 || math.IsNaN(cfg.rate) || math.IsNaN(cfg.burst) || math.IsInf(cfg.rate, 0) || math.IsInf(cfg.burst, 0) {
		return cfg, fmt.Errorf("log rate and burst must not be negative")
	}
	if cfg.rate > 0 && cfg.burst == 0 {
		cfg.burst = max(1, cfg.rate)
	}
	if cfg.rate > 0 && cfg.burst < 1 {
		return cfg, fmt.Errorf("RATE_BURST must be at least 1 when rate limiting is enabled")
	}
	return cfg, nil
}

func parseLogPatterns(initial []logPattern, value string) ([]logPattern, error) {
	out := append([]logPattern(nil), initial...)
	for _, part := range splitLogConfigList(value) {
		if strings.HasPrefix(part, "re:") {
			pattern, err := regexp.Compile(strings.TrimPrefix(part, "re:"))
			if err != nil {
				return nil, err
			}
			out = append(out, logPattern{regex: pattern})
		} else {
			out = append(out, logPattern{text: part})
		}
	}
	return out, nil
}

func parseLogMasks(value string) ([]logMaskRule, error) {
	var out []logMaskRule
	for _, part := range splitLogConfigList(value) {
		patternText, replacement, ok := strings.Cut(part, "=>")
		if !ok {
			return nil, fmt.Errorf("mask rule %q must be regex=>replacement", part)
		}
		pattern, err := regexp.Compile(strings.TrimPrefix(patternText, "re:"))
		if err != nil {
			return nil, err
		}
		out = append(out, logMaskRule{pattern: pattern, replacement: replacement})
	}
	return out, nil
}

func splitLogConfigList(value string) []string {
	var out []string
	for _, item := range strings.Split(value, ";") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

func slicesContains(values []string, value string) bool {
	for _, candidate := range values {
		if strings.EqualFold(candidate, value) {
			return true
		}
	}
	return false
}

func emailReplacement(match string) string {
	local, domain, ok := strings.Cut(match, "@")
	if !ok {
		return "[REDACTED]"
	}
	sum := sha256.Sum256([]byte(strings.ToLower(local + "@" + domain)))
	return hex.EncodeToString(sum[:4]) + "@" + domain
}

func parseLogLevel(value string) int {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "DEBUG":
		return 7
	case "INFO":
		return 6
	case "WARN", "WARNING":
		return 4
	case "ERROR":
		return 3
	case "FATAL":
		return 2
	default:
		return -1
	}
}

func lineLogLevel(line string) int {
	if first, _, ok := strings.Cut(line, "\n"); ok {
		line = first
	}
	if m := syslogPriPattern.FindStringSubmatch(line); m != nil {
		priority, _ := strconv.Atoi(m[1])
		if priority <= 191 {
			return priority % 8
		}
	}
	if m := journalPriPattern.FindStringSubmatch(line); m != nil {
		priority, _ := strconv.Atoi(m[1])
		return priority
	}
	if m := levelPattern.FindStringSubmatch(line); m != nil {
		switch strings.ToUpper(m[1]) {
		case "DEBUG":
			return 7
		case "INFO":
			return 6
		case "WARN", "WARNING":
			return 4
		case "ERROR":
			return 3
		case "FATAL":
			return 2
		}
	}
	return -1
}

func stripANSI(line string) string { return ansiEscapePattern.ReplaceAllString(line, "") }

type logEntry struct {
	line        string
	raw         string
	time        string
	rawLines    int
	rateRank    int
	hasRateRank bool
	rateWindow  uint64
	maskedLines uint64
	historical  bool
	truncated   bool
	overflow    bool
}

func applyLogPipeline(lines, times []string, cfg logPipelineConfig, state logPipelineState, counters logCounters, now time.Time) ([]string, []string, logPipelineState, logCounters) {
	previousRateLimited := counters.RateLimited
	entries, state, counters := processLogPipeline(lines, times, nil, false, cfg, state, counters, now)
	if cfg.rate > 0 {
		entries, state, counters = limitLogEntries(entries, cfg, state, counters, now)
	}
	counters.RateLimitedCurrent = counters.RateLimited - previousRateLimited
	outLines, outTimes, counters := shippedLogEntries(entries, counters)
	return outLines, outTimes, state, counters
}

// Raw entries are bounded independently of the output cap so filters still see
// continuation lines that do not fit in the rendered entry.
const logRawEntryMaxBytes = 2 << 20

func processLogPipeline(lines, times, streams []string, reset bool, cfg logPipelineConfig, state logPipelineState, counters logCounters, now time.Time) ([]logEntry, logPipelineState, logCounters) {
	return processLogPipelineWithHistory(lines, times, streams, nil, reset, cfg, state, counters, now, false, nil)
}

func processLogPipelineWithHistory(lines, times, streams []string, historical []bool, reset bool, cfg logPipelineConfig, state logPipelineState, counters logCounters, now time.Time, hasMore bool, pendingStreams map[string]bool) ([]logEntry, logPipelineState, logCounters) {
	maskConfig := logMaskFingerprint(cfg)
	for _, line := range lines {
		counters.Read += uint64(logLineCount(line))
	}
	newestLag := int64(-1)
	for _, value := range times {
		if at, err := time.Parse(time.RFC3339Nano, value); err == nil {
			lag := now.Sub(at).Milliseconds()
			if lag < 0 {
				lag = 0
			}
			if newestLag < 0 || lag < newestLag {
				newestLag = lag
			}
		}
	}
	counters.ReadLagMS = newestLag
	if state.Streams != nil {
		cloned := make(map[string]logStreamState, len(state.Streams))
		for key, stream := range state.Streams {
			cloned[key] = stream
		}
		state.Streams = cloned
	}
	var entries []logEntry
	flush := func(stream *logStreamState) {
		line := stream.HeldLine
		if stream.HeldMaskConfig != maskConfig {
			log.Printf("robin-agent: warning: redacted a held log entry after its mask configuration changed")
			line = "[REDACTED]"
		}
		entries = append(entries, logEntry{
			line: line, raw: stream.HeldRaw, time: stream.HeldTime,
			rawLines: stream.HeldLines, historical: stream.HeldReset,
			truncated: stream.HeldTruncated, overflow: stream.HeldOverflow,
			rateWindow: stream.HeldRateWindow,
		})
		loginRemaining, loginChallenged := stream.LoginRemaining, stream.LoginChallenged
		loginInFlight, loginObserved := stream.LoginInFlight, stream.LoginObserved
		*stream = logStreamState{
			LoginRemaining: loginRemaining, LoginChallenged: loginChallenged,
			LoginInFlight: loginInFlight, LoginObserved: loginObserved,
		}
	}
	migrate := func(stream *logStreamState) {
		if stream.HeldOpen || stream.HeldLine == "" {
			return
		}
		// Older cursors kept only the masked entry. It cannot safely be
		// evaluated against raw include/exclude rules after an upgrade.
		if cfg.sourceFilter != "" || len(cfg.include) > 0 || len(cfg.exclude) > 0 {
			log.Printf("robin-agent: warning: discarded a legacy held log entry whose raw filter input was not retained")
			counters.Excluded += uint64(logLineCount(stream.HeldLine))
			loginRemaining, loginChallenged := stream.LoginRemaining, stream.LoginChallenged
			loginInFlight, loginObserved := stream.LoginInFlight, stream.LoginObserved
			*stream = logStreamState{
				LoginRemaining: loginRemaining, LoginChallenged: loginChallenged,
				LoginInFlight: loginInFlight, LoginObserved: loginObserved,
			}
			return
		}
		stream.HeldOpen, stream.HeldRaw = true, stream.HeldLine
		stream.HeldLines = strings.Count(stream.HeldLine, "\n") + 1
	}
	migrate(&state.logStreamState)
	if state.HeldOpen && state.HeldRateWindow == 0 {
		state.HeldRateWindow = state.rateWindow
	}
	for key, stream := range state.Streams {
		migrate(&stream)
		if stream.HeldOpen && stream.HeldRateWindow == 0 {
			stream.HeldRateWindow = state.rateWindow
		}
		state.Streams[key] = stream
	}
	for i, raw := range lines {
		isHistorical := reset || i < len(historical) && historical[i]
		key := ""
		if i < len(streams) {
			key = streams[i]
		}
		stream := state.logStreamState
		if key != "" {
			if state.Streams == nil {
				state.Streams = make(map[string]logStreamState)
			}
			stream = state.Streams[key]
		}
		raw = stripANSI(raw)
		var safe string
		safe, _, stream = maskAuthLine(raw, cfg.authMask, stream)
		at := ""
		if i < len(times) {
			at = times[i]
		}
		boundary := raw
		if key != "" {
			if _, text, ok := strings.Cut(raw, "] "); ok && strings.HasPrefix(raw, "[") {
				boundary = text
			}
		}
		starts := cfg.entryStart.MatchString(boundary)
		if stream.HeldOpen && starts {
			flush(&stream)
		}
		if !stream.HeldOpen {
			if starts {
				stream.HeldOpen, stream.HeldLine, stream.HeldRaw = true, safe, raw
				stream.HeldTime, stream.HeldSince, stream.HeldLines = at, now, logLineCount(raw)
				stream.HeldReset = isHistorical
				stream.HeldMaskConfig = maskConfig
				stream.HeldRateWindow = state.rateWindow
			} else {
				entries = append(entries, logEntry{
					line: safe, raw: raw, time: at, rawLines: logLineCount(raw),
					historical: isHistorical, rateWindow: state.rateWindow,
				})
			}
		} else {
			stream.HeldLines += logLineCount(raw)
			stream.HeldSince = now
			if stream.HeldTime == "" {
				stream.HeldTime = at
			}
			if len(stream.HeldRaw)+1+len(raw) <= logRawEntryMaxBytes &&
				len(stream.HeldLine)+1+len(safe) <= logRawEntryMaxBytes && !stream.HeldOverflow {
				stream.HeldRaw += "\n" + raw
				stream.HeldLine += "\n" + safe
			} else {
				stream.HeldOverflow = true
			}
			if stream.HeldLines > cfg.entryLines {
				stream.HeldTruncated = true
			}
		}
		if stream.HeldOpen && len(stream.HeldRaw) > logRawEntryMaxBytes {
			stream.HeldRaw = stream.HeldRaw[:logRawEntryMaxBytes]
			stream.HeldOverflow = true
		}
		if stream.HeldOpen && len(stream.HeldLine) > logRawEntryMaxBytes {
			stream.HeldLine = stream.HeldLine[:logRawEntryMaxBytes]
			stream.HeldOverflow = true
		}
		if key == "" {
			state.logStreamState = stream
		} else {
			state.Streams[key] = stream
		}
	}
	// Unread records or incomplete Docker lines may still contain continuations.
	pending := func(key string) bool {
		if pendingStreams == nil {
			return hasMore
		}
		return pendingStreams[key]
	}
	if !pending("") && state.HeldOpen && now.Sub(state.HeldSince) >= 2*time.Second {
		flush(&state.logStreamState)
	}
	keys := make([]string, 0, len(state.Streams))
	for key := range state.Streams {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		stream := state.Streams[key]
		if !pending(key) && stream.HeldOpen && now.Sub(stream.HeldSince) >= 2*time.Second {
			flush(&stream)
		}
		if !stream.HeldOpen && stream.LoginRemaining == 0 && !stream.LoginObserved {
			delete(state.Streams, key)
		} else {
			state.Streams[key] = stream
		}
	}
	filtered := make([]logEntry, 0, len(entries))
	maxEntryBytes := min(cfg.entryBytes, logLineMaxBytes)
	for _, entry := range entries {
		excluded := entry.overflow
		if excluded {
			log.Printf("robin-agent: warning: discarded an oversized log entry that could not be safely filtered and masked")
			counters.Truncated++
		}
		for _, rule := range cfg.exclude {
			if rule.matches(entry.raw) {
				excluded = true
				break
			}
		}
		if !excluded && cfg.minimumLevel >= 0 {
			if level := lineLogLevel(entry.raw); level >= 0 && level > cfg.minimumLevel {
				excluded = true
			}
		}
		if !excluded && cfg.sourceFilter != "" && !strings.Contains(entry.raw, cfg.sourceFilter) {
			excluded = true
		}
		if !excluded && len(cfg.include) > 0 {
			excluded = true
			for _, rule := range cfg.include {
				if rule.matches(entry.raw) {
					excluded = false
					break
				}
			}
		}
		if excluded {
			counters.Excluded += uint64(max(1, entry.rawLines))
			continue
		}
		safe := entry.line
		entry.line, _ = maskLogEntry(entry.raw, safe, cfg.masks)
		if cfg.customMaskCount > 0 {
			// A custom replacement must not hide a credential from built-in masks.
			protected, _ := maskLogEntry(entry.raw, safe, cfg.masks[cfg.customMaskCount:])
			if protected != safe {
				protected, _ = maskLogEntry(protected, protected, cfg.masks[:cfg.customMaskCount])
				if entry.line != protected {
					entry.line = "[REDACTED]"
				}
			}
		}
		entry.maskedLines = maskedLogLineCount(entry.raw, entry.line)
		counters.Masked += entry.maskedLines
		if line, truncated := limitLogEntryLines(entry.line, cfg.entryLines); truncated {
			entry.line = line
			entry.truncated = true
		}
		if len(entry.line) > maxEntryBytes {
			entry.line = truncateUTF8(entry.line, maxEntryBytes)
			entry.truncated = true
		}
		if entry.truncated || entry.overflow {
			counters.Truncated++
		}
		if cfg.rate > 0 && entry.raw != entry.line {
			entry.rateRank, entry.hasRateRank = severityRank(entry.raw), true
		}
		entry.raw = ""
		if entry.line != "" {
			filtered = append(filtered, entry)
		}
	}
	counters.UpdatedAt = now
	return filtered, state, counters
}

func shippedLogEntries(filtered []logEntry, counters logCounters) ([]string, []string, logCounters) {
	outLines := make([]string, 0, len(filtered))
	outTimes := make([]string, 0, len(filtered))
	for _, entry := range filtered {
		outLines = append(outLines, entry.line)
		outTimes = append(outTimes, entry.time)
		counters.Shipped += uint64(logLineCount(entry.line))
		counters.BytesShipped += uint64(len(entry.line))
	}
	return outLines, outTimes, counters
}

func logLineCount(line string) int {
	return strings.Count(line, "\n") + 1
}

func maskAuthLine(line string, enabled bool, state logStreamState) (string, bool, logStreamState) {
	masked := false
	if enabled {
		if authLoginPattern.MatchString(line) {
			if state.LoginInFlight == 0 && state.LoginRemaining > 0 {
				state.LoginInFlight = 1
			}
			state.LoginInFlight++
			state.LoginRemaining += 2
			state.LoginObserved = true
			if authLoginInitialPattern.MatchString(line) {
				line = authLoginInitialPattern.ReplaceAllString(line, "${1}[REDACTED]${2}")
				state.LoginRemaining--
				masked = true
			}
		} else if authPlainCommandPattern.MatchString(line) {
			if state.LoginInFlight == 0 && state.LoginRemaining > 0 {
				state.LoginInFlight = 1
			}
			state.LoginInFlight++
			state.LoginRemaining++
			state.LoginObserved = true
		} else if state.LoginRemaining > 0 || state.LoginObserved {
			switch {
			case authChallengePattern.MatchString(line):
				if state.LoginRemaining > 0 {
					state.LoginChallenged = true
				}
			case authResultPattern.MatchString(line):
				if state.LoginInFlight > 1 {
					state.LoginInFlight--
					state.LoginRemaining = max(1, state.LoginRemaining)
				} else {
					state.LoginRemaining, state.LoginInFlight = 0, 0
					state.LoginChallenged = false
				}
			default:
				payload := isAuthLoginPayload(line)
				if state.LoginRemaining > 0 {
					if payload && (state.LoginRemaining > 1 || !state.LoginChallenged) {
						state.LoginRemaining--
					}
					line, masked = "[REDACTED]", true
				} else if state.LoginObserved && payload {
					line, masked = "[REDACTED]", true
				}
			}
		}
	}
	return line, masked, state
}

func logMaskFingerprint(cfg logPipelineConfig) string {
	var data strings.Builder
	fmt.Fprintf(&data, "%t;", cfg.authMask)
	for _, rule := range cfg.masks {
		pattern := rule.pattern.String()
		fmt.Fprintf(&data, "%d:%s%d:%s", len(pattern), pattern, len(rule.replacement), rule.replacement)
	}
	sum := sha256.Sum256([]byte(data.String()))
	return hex.EncodeToString(sum[:])
}

func logFilterFingerprint(cfg logPipelineConfig) string {
	var data strings.Builder
	fmt.Fprintf(&data, "%d:%s;%d;", len(cfg.sourceFilter), cfg.sourceFilter, cfg.minimumLevel)
	for _, patterns := range [][]logPattern{cfg.include, cfg.exclude} {
		fmt.Fprintf(&data, "%d;", len(patterns))
		for _, pattern := range patterns {
			if pattern.regex != nil {
				text := pattern.regex.String()
				fmt.Fprintf(&data, "r%d:%s", len(text), text)
			} else {
				fmt.Fprintf(&data, "s%d:%s", len(pattern.text), pattern.text)
			}
		}
	}
	sum := sha256.Sum256([]byte(data.String()))
	return hex.EncodeToString(sum[:])
}

// AUTH state must be tracked while reading; all other masks run after assembly
// and filtering. An overlapping AUTH redaction fails closed for the entry.
func maskLogEntry(raw, safe string, rules []logMaskRule) (string, bool) {
	masked := false
	compare := raw != safe
	lower, ascii := asciiLowerForMask(safe)
	for _, rule := range rules {
		if compare && !slices.Equal(rule.pattern.FindAllString(raw, -1), rule.pattern.FindAllString(safe, -1)) {
			return "[REDACTED]", true
		}
		if !logMaskMayMatch(rule.pattern, lower, ascii) {
			continue
		}
		if !rule.pattern.MatchString(safe) {
			continue
		}
		replace := func(value string) string {
			return rule.pattern.ReplaceAllStringFunc(value, func(match string) string {
				if rule.pattern == emailPattern {
					return emailReplacement(match)
				}
				return rule.pattern.ReplaceAllString(match, rule.replacement)
			})
		}
		safe = replace(safe)
		if compare {
			raw = replace(raw)
		}
		lower, ascii = asciiLowerForMask(safe)
		masked = true
	}
	return safe, masked
}

func asciiLowerForMask(value string) (string, bool) {
	for i := 0; i < len(value); i++ {
		if value[i] >= utf8.RuneSelf {
			return "", false
		}
	}
	return strings.ToLower(value), true
}

func logMaskMayMatch(pattern *regexp.Regexp, lower string, ascii bool) bool {
	if !ascii {
		return true
	}
	switch pattern {
	case credentialPattern, credentialJSONPattern:
		for _, name := range []string{"password", "passwd", "pwd", "secret", "token", "apikey", "api_key", "api-key", "authorization"} {
			if strings.Contains(lower, name) {
				return true
			}
		}
		return false
	case authorizationPattern:
		return strings.Contains(lower, "authorization")
	case bearerPattern:
		return strings.Contains(lower, "bearer")
	case emailPattern:
		return strings.Contains(lower, "@")
	case authPlainPattern:
		return strings.Contains(lower, "auth") && strings.Contains(lower, "plain")
	case imapLoginPattern, imapIncompletePattern:
		return strings.Contains(lower, "login")
	default:
		return true
	}
}

func maskedLogLineCount(raw, masked string) uint64 {
	if raw == masked {
		return 0
	}
	rawLines, maskedLines := strings.Split(raw, "\n"), strings.Split(masked, "\n")
	if len(rawLines) != len(maskedLines) {
		return uint64(len(rawLines))
	}
	var count uint64
	for i := range rawLines {
		if rawLines[i] != maskedLines[i] {
			count++
		}
	}
	return count
}

func limitLogEntryLines(value string, limit int) (string, bool) {
	offset := 0
	for i := 0; i < limit; i++ {
		next := strings.IndexByte(value[offset:], '\n')
		if next < 0 {
			return value, false
		}
		if i == limit-1 {
			return value[:offset+next], true
		}
		offset += next + 1
	}
	return value, false
}

func isAuthLoginPayload(line string) bool {
	if strings.HasPrefix(line, "[") {
		if _, text, ok := strings.Cut(line, "] "); ok {
			line = text
		}
	}
	token := strings.TrimSpace(line)
	if match := authClientPayloadPattern.FindStringSubmatch(line); match != nil {
		token = match[1]
	}
	if !authPayloadPattern.MatchString(token) {
		return false
	}
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if _, err := encoding.DecodeString(token); err == nil {
			return true
		}
	}
	return false
}

// Keep completed candidates with the window in which their multiline entry
// began. Selection waits for that window's held entries, including after restart.
func finishLogRateWindows(entries []logEntry, cfg logPipelineConfig, state logPipelineState, counters logCounters, now time.Time) ([]logEntry, logPipelineState, logCounters) {
	filterConfig, maskConfig := logFilterFingerprint(cfg), logMaskFingerprint(cfg)
	windows := append([]logRateWindow(nil), state.RateWindows...)
	bufferedBytes, bufferedEntries := 0, 0
	for i := range windows {
		windows[i].Entries = append([]pendingLogRateEntry(nil), windows[i].Entries...)
		for _, entry := range windows[i].Entries {
			bufferedBytes += len(entry.Line)
			bufferedEntries++
		}
	}
	windows = append(windows, logRateWindow{
		ID: state.rateWindow, End: now, MaskConfig: maskConfig,
		FilterConfig: filterConfig,
	})
	windowIndex := make(map[uint64]int, len(windows))
	for i := range windows {
		windowIndex[windows[i].ID] = i
	}
	var overflow uint64
	for _, entry := range entries {
		id := entry.rateWindow
		if id == 0 {
			id = state.rateWindow
		}
		if bufferedEntries >= 80000 || bufferedBytes+len(entry.line) > 16<<20 {
			overflow += uint64(logLineCount(entry.line))
			continue
		}
		i, ok := windowIndex[id]
		if !ok {
			i = len(windows) - 1
		}
		windows[i].Entries = append(windows[i].Entries, pendingLogRateEntry{
			Line: entry.line, Time: entry.time, RawLines: entry.rawLines,
			RateRank: entry.rateRank, HasRateRank: entry.hasRateRank, Historical: entry.historical,
		})
		bufferedBytes += len(entry.line)
		bufferedEntries++
	}
	if overflow > 0 {
		log.Printf("robin-agent: warning: dropped %d log lines because deferred rate windows reached their buffer limit", overflow)
		counters.RateLimited += overflow
		state.PendingRateDrops += overflow
	}
	open := make(map[uint64]bool)
	if cfg.rate > 0 && state.HeldOpen {
		open[state.HeldRateWindow] = true
	}
	for _, stream := range state.Streams {
		if cfg.rate > 0 && stream.HeldOpen {
			open[stream.HeldRateWindow] = true
		}
	}
	nonempty := windows[:0]
	for _, window := range windows {
		if len(window.Entries) > 0 || open[window.ID] {
			nonempty = append(nonempty, window)
		}
	}
	windows = nonempty
	var out []logEntry
	processed := 0
	for _, window := range windows {
		if open[window.ID] {
			break
		}
		var candidates []logEntry
		for _, entry := range window.Entries {
			if window.FilterConfig != filterConfig {
				counters.Excluded += uint64(max(1, entry.RawLines))
				continue
			}
			line := entry.Line
			if window.MaskConfig != maskConfig {
				line = "[REDACTED]"
			}
			candidates = append(candidates, logEntry{
				line: line, time: entry.Time, rawLines: entry.RawLines,
				rateRank: entry.RateRank, hasRateRank: entry.HasRateRank, historical: entry.Historical,
			})
		}
		var selected []logEntry
		if cfg.rate > 0 {
			selected, state, counters = limitLogEntries(candidates, cfg, state, counters, window.End)
		} else {
			selected = candidates
			state.Tokens, state.LastRefill = 0, time.Time{}
		}
		out = append(out, selected...)
		processed++
	}
	state.RateWindows = append([]logRateWindow(nil), windows[processed:]...)
	if cfg.rate > 0 && len(windows) == 0 {
		out, state, counters = limitLogEntries(nil, cfg, state, counters, now)
	}
	return out, state, counters
}

func limitLogEntries(entries []logEntry, cfg logPipelineConfig, state logPipelineState, counters logCounters, now time.Time) ([]logEntry, logPipelineState, logCounters) {
	start := state.LastRefill
	tokens := max(0, minFloat(cfg.burst, state.Tokens))
	if start.IsZero() {
		start, tokens = now, cfg.burst
	} else if !start.Before(now) {
		start = now
	} else if windowStart := now.Add(-30 * time.Second); start.Before(windowStart) {
		tokens = minFloat(cfg.burst, tokens+windowStart.Sub(start).Seconds()*cfg.rate)
		start = windowStart
	}
	events := make([]logRateEvent, len(entries))
	estimate := false
	totalLines := 0
	for i, entry := range entries {
		at, err := time.Parse(time.RFC3339Nano, entry.time)
		if err != nil || at.Before(start) || at.After(now) {
			estimate = true
		}
		cost := logLineCount(entry.line)
		totalLines += cost
		events[i] = logRateEvent{index: i, at: at, cost: cost}
	}
	if estimate {
		window := now.Sub(start)
		for i := range events {
			events[i].at = start.Add(window * time.Duration(i+1) / time.Duration(len(events)))
		}
	} else {
		sort.SliceStable(events, func(i, j int) bool { return events[i].at.Before(events[j].at) })
	}
	last := start
	for i := range events {
		events[i].refill = minFloat(cfg.burst, events[i].at.Sub(last).Seconds()*cfg.rate)
		last = events[i].at
	}
	remaining := tokens
	allFit := true
	for _, event := range events {
		remaining = minFloat(cfg.burst, remaining+event.refill)
		if remaining < float64(event.cost) {
			allFit = false
			break
		}
		remaining -= float64(event.cost)
	}
	out := entries
	var dropped uint64
	if !allFit {
		for i := range events {
			entry := entries[events[i].index]
			if entry.hasRateRank {
				events[i].rank = entry.rateRank
			} else {
				events[i].rank = severityRank(entry.line)
			}
		}
		allowed := selectLogRateEvents(events, minFloat(cfg.burst, float64(totalLines)), tokens)
		out = make([]logEntry, 0, len(entries)+1)
		for i, entry := range entries {
			if allowed[i] {
				out = append(out, entry)
			} else {
				dropped += uint64(logLineCount(entry.line))
			}
		}
		remaining = tokens
		for _, event := range events {
			remaining = minFloat(cfg.burst, remaining+event.refill)
			if allowed[event.index] {
				remaining = max(0, remaining-float64(event.cost))
			}
		}
	}
	state.Tokens = minFloat(cfg.burst, remaining+now.Sub(last).Seconds()*cfg.rate)
	state.LastRefill = now
	if dropped > 0 {
		counters.RateLimited += dropped
		state.PendingRateDrops += dropped
	}
	if state.PendingRateDrops > 0 && (state.LastDropSummary.IsZero() || now.Sub(state.LastDropSummary) >= time.Second) {
		stamp := now.Format(time.RFC3339Nano)
		historical := len(entries) > 0
		for _, entry := range entries {
			historical = historical && entry.historical
		}
		out = append(out, logEntry{line: fmt.Sprintf("%d lines dropped by rate limit", state.PendingRateDrops), time: stamp, historical: historical})
		state.PendingRateDrops = 0
		state.LastDropSummary = now
	}
	return out, state, counters
}

type logRateEvent struct {
	index  int
	at     time.Time
	refill float64
	rank   int
	cost   int
}

type logRateScore [6]uint32

func logRateScoreGreater(a, b *logRateScore) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func logRateScoreWithEventGreater(a, b *logRateScore, slot int, cost uint32) bool {
	for i := range a {
		value := a[i]
		if i == slot {
			value += cost
		}
		if value != b[i] {
			return value > b[i]
		}
	}
	return false
}

type logRateChoice struct {
	index, previous uint32
}

type logRateState struct {
	finish float64
	score  logRateScore
	origin uint32
	choice uint32
}

type logRateCheckpoint struct {
	clock  float64
	states []logRateState
}

// Each state describes a token bucket's outstanding work and its retained
// severity counts. A state with both a later finish and no higher score can
// never improve any subsequent choice and is removed from the frontier.
func advanceLogRateFrontier(states, next []logRateState, event logRateEvent, clock, burst float64, choices *[]logRateChoice) ([]logRateState, float64) {
	clock += event.refill
	if states[len(states)-1].finish <= clock {
		states = states[len(states)-1:]
		states[0].finish, clock = 0, 0
	} else if idle := sort.Search(len(states), func(i int) bool { return states[i].finish > clock }); idle > 0 {
		states = states[idle-1:]
		states[0].finish = clock
	}
	eligible := sort.Search(len(states), func(i int) bool {
		return states[i].finish+float64(event.cost) > clock+burst+1e-9
	})
	next = next[:0]
	cost, slot, scoreCost := float64(event.cost), 4-event.rank, uint32(event.cost)
	for i, j := 0, 0; i < len(states) || j < eligible; {
		var index int
		take := false
		switch {
		case j == eligible:
			index = i
			i++
		case i == len(states):
			index, take = j, true
			j++
		default:
			finish := states[j].finish + cost
			switch {
			case states[i].finish < finish:
				index = i
				i++
			case states[i].finish > finish:
				index, take = j, true
				j++
			default:
				if logRateScoreWithEventGreater(&states[j].score, &states[i].score, slot, scoreCost) {
					index, take = j, true
				} else {
					index = i
				}
				i++
				j++
			}
		}
		if take {
			if len(next) > 0 && !logRateScoreWithEventGreater(&states[index].score, &next[len(next)-1].score, slot, scoreCost) {
				continue
			}
			candidate := states[index]
			candidate.finish += cost
			candidate.score[slot] += scoreCost
			if choices != nil {
				*choices = append(*choices, logRateChoice{index: uint32(event.index), previous: candidate.choice})
				candidate.choice = uint32(len(*choices))
			}
			next = append(next, candidate)
		} else if len(next) == 0 || logRateScoreGreater(&states[index].score, &next[len(next)-1].score) {
			next = append(next, states[index])
		}
	}
	return next, clock
}

func selectLogRateEvents(events []logRateEvent, burst, tokens float64) []bool {
	allowed := make([]bool, len(events))
	uniform := events[0].cost == 1
	for _, event := range events[1:] {
		if event.rank != events[0].rank || event.cost != 1 {
			uniform = false
			break
		}
	}
	if uniform {
		for _, event := range events {
			tokens = minFloat(burst, tokens+event.refill)
			if tokens >= 1-1e-9 {
				allowed[event.index] = true
				tokens = max(0, tokens-1)
			}
		}
		return allowed
	}

	const checkpointStride = 128
	states := []logRateState{{finish: burst - tokens}}
	var buffer []logRateState
	clock := 0.0
	checkpoints := []logRateCheckpoint{{states: append([]logRateState(nil), states...)}}
	for i, event := range events {
		next, nextClock := advanceLogRateFrontier(states, buffer, event, clock, burst, nil)
		states, buffer, clock = next, states[:0], nextClock
		if (i+1)%checkpointStride == 0 && i+1 < len(events) {
			checkpoints = append(checkpoints, logRateCheckpoint{
				clock: clock, states: append([]logRateState(nil), states...),
			})
		}
	}

	// Replaying bounded chunks keeps selection history small even for a
	// long, rate-limited collection window.
	selected := len(states) - 1
	var choices []logRateChoice
	for chunk := len(checkpoints) - 1; chunk >= 0; chunk-- {
		states = append(states[:0], checkpoints[chunk].states...)
		for i := range states {
			states[i].origin, states[i].choice = uint32(i), 0
		}
		choices = choices[:0]
		clock = checkpoints[chunk].clock
		start, end := chunk*checkpointStride, min((chunk+1)*checkpointStride, len(events))
		for _, event := range events[start:end] {
			next, nextClock := advanceLogRateFrontier(states, buffer, event, clock, burst, &choices)
			states, buffer, clock = next, states[:0], nextClock
		}
		for index := states[selected].choice; index != 0; {
			choice := choices[index-1]
			allowed[choice.index] = true
			index = choice.previous
		}
		selected = int(states[selected].origin)
	}
	return allowed
}

func severityRank(line string) int {
	level := lineLogLevel(line)
	if level < 0 {
		return -1
	}
	switch {
	case level >= 7:
		return 0
	case level >= 6:
		return 1
	case level >= 4:
		return 2
	case level >= 3:
		return 3
	default:
		return 4
	}
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func truncateUTF8(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	value = value[:limit]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}
