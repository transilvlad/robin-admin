package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	probeResponseLimit = 1 << 20
	probeRequestLimit  = 64 << 10
	probeBannerLimit   = 8 << 10
	probeDNSLimit      = 128
)

// probeCheck is the normalized, versioned check definition consumed by both
// probe engines. SecretHeaders are supplied only in memory by the manifest.
type probeCheck struct {
	CheckID              int               `json:"checkId"`
	Name                 string            `json:"name"`
	CheckType            string            `json:"checkType"`
	Endpoint             string            `json:"endpoint"`
	Port                 *int              `json:"port"`
	IntervalSeconds      int               `json:"intervalSeconds"`
	TimeoutSeconds       int               `json:"timeoutSeconds"`
	ConfirmationSeconds  int               `json:"confirmationSeconds"`
	RecoverySeconds      int               `json:"recoverySeconds"`
	CertExpiryDays       *int              `json:"certExpiryDays"`
	TLSMode              string            `json:"tlsMode"`
	CertificateErrorMode string            `json:"certificateErrorMode"`
	AllowPrivate         bool              `json:"allowPrivate"`
	Options              json.RawMessage   `json:"options"`
	SecretHeaders        map[string]string `json:"secretHeaders,omitempty"`
	Enabled              bool              `json:"enabled"`
	JitterSeed           int               `json:"jitterSeed,omitempty"`
}

type monitoringProbeResult struct {
	Status         string         `json:"status"`
	ErrorCode      string         `json:"errorCode,omitempty"`
	Warning        string         `json:"warning,omitempty"`
	ResponseTimeMs int64          `json:"responseTimeMs"`
	DNSTimeMs      int64          `json:"dnsTimeMs"`
	Details        map[string]any `json:"details"`
}

type probeFailure struct {
	code    string
	message string
	details map[string]any
	warning bool
}

func (e *probeFailure) Error() string { return e.message }

type probeHTTPOptions struct {
	Method            string            `json:"method"`
	Headers           map[string]string `json:"headers"`
	Body              string            `json:"body"`
	ExpectedStatuses  []int             `json:"expectedStatuses"`
	FollowRedirects   bool              `json:"followRedirects"`
	MaxRedirects      int               `json:"maxRedirects"`
	MaxResponseTimeMs *int              `json:"maxResponseTimeMs"`
	Assertions        []probeAssertion  `json:"assertions"`
}

type probeTCPOptions struct {
	TLS            bool   `json:"tls"`
	BannerContains string `json:"bannerContains"`
}

type probeDNSOptions struct {
	RecordType     string   `json:"recordType"`
	Resolver       string   `json:"resolver"`
	ExpectedValues []string `json:"expectedValues"`
}

type probeStartTLSOptions struct {
	StartTLS *bool `json:"startTls"`
}

type probeOptions struct {
	HTTP *probeHTTPOptions     `json:"http"`
	TCP  *probeTCPOptions      `json:"tcp"`
	DNS  *probeDNSOptions      `json:"dns"`
	SMTP *probeStartTLSOptions `json:"smtp"`
	IMAP *probeStartTLSOptions `json:"imap"`
}

type probeAssertion struct {
	Kind     string          `json:"kind"`
	Operator string          `json:"operator"`
	Name     string          `json:"name"`
	Pointer  string          `json:"pointer"`
	Value    json.RawMessage `json:"value"`
}

func runProbe(parent context.Context, check probeCheck) monitoringProbeResult {
	started := time.Now()
	if check.TimeoutSeconds < 1 || check.TimeoutSeconds > 120 {
		return failedProbe(started, &probeFailure{code: "probe_failed", message: "Invalid probe timeout"})
	}
	if err := validateProbeCheck(check); err != nil {
		return failedProbe(started, err)
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(check.TimeoutSeconds)*time.Second)
	defer cancel()
	timing := &probeTiming{}
	ctx = context.WithValue(ctx, probeTimingKey{}, timing)
	var details map[string]any
	var warning string
	var err error
	switch check.CheckType {
	case "http":
		details, warning, err = probeHTTP(ctx, check)
	case "tcp":
		details, warning, err = probeTCP(ctx, check)
	case "dns":
		details, warning, err = probeDNS(ctx, check)
	case "smtp":
		details, warning, err = probeSMTP(ctx, check)
	case "imap":
		details, warning, err = probeIMAP(ctx, check)
	default:
		err = &probeFailure{code: "probe_failed", message: "Unsupported check type"}
	}
	if err != nil {
		var failure *probeFailure
		if !errors.As(err, &failure) {
			failure = classifyProbeError(ctx, err)
		}
		result := failedProbe(timing.origin(started), failure)
		result.DNSTimeMs = numberAsInt64(result.Details["dnsTimeMs"])
		return result
	}
	result := monitoringProbeResult{Status: "up", ResponseTimeMs: time.Since(timing.origin(started)).Milliseconds(), Details: details}
	if warning != "" {
		result.Status = "warning"
		result.Warning = warning
	}
	if details == nil {
		details = map[string]any{}
	}
	result.DNSTimeMs = numberAsInt64(details["dnsTimeMs"])
	if check.CheckType == "http" && check.Options != nil {
		var options probeOptions
		if json.Unmarshal(check.Options, &options) == nil && options.HTTP != nil &&
			options.HTTP.MaxResponseTimeMs != nil && result.ResponseTimeMs > int64(*options.HTTP.MaxResponseTimeMs) {
			return failedProbe(timing.origin(started), &probeFailure{code: "probe_failed", message: "Maximum HTTP response time exceeded", details: details})
		}
	}
	return result
}

type probeTimingKey struct{}

// probeTiming records when the first connection attempt began, so response time
// excludes the initial DNS lookup exactly as the TypeScript engine does.
type probeTiming struct {
	mu                sync.Mutex
	connectionStarted time.Time
}

func (t *probeTiming) mark() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.connectionStarted.IsZero() {
		t.connectionStarted = time.Now()
	}
}

func (t *probeTiming) origin(started time.Time) time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.connectionStarted.IsZero() {
		return started
	}
	return t.connectionStarted
}

func failedProbe(started time.Time, failure *probeFailure) monitoringProbeResult {
	details := failure.details
	if details == nil {
		details = map[string]any{}
	}
	warning := ""
	if failure.warning {
		warning = failure.message
	}
	return monitoringProbeResult{
		Status:         map[bool]string{true: "warning", false: "down"}[failure.warning],
		ErrorCode:      failure.code,
		Warning:        warning,
		ResponseTimeMs: time.Since(started).Milliseconds(),
		Details:        details,
	}
}

func classifyProbeError(ctx context.Context, err error) *probeFailure {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return &probeFailure{code: "probe_timeout", message: "Probe timed out"}
	}
	var networkErr net.Error
	if errors.As(err, &networkErr) && networkErr.Timeout() {
		return &probeFailure{code: "probe_timeout", message: "Probe timed out"}
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return &probeFailure{code: "dns_failed", message: "Target DNS resolution failed"}
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return &probeFailure{code: "connect_refused", message: "Target connection refused"}
	}
	return &probeFailure{code: "probe_failed", message: "Probe failed"}
}

func decodeProbeOptions(check probeCheck) (probeOptions, error) {
	var options probeOptions
	if len(check.Options) == 0 || string(check.Options) == "null" {
		check.Options = json.RawMessage("{}")
	}
	if err := json.Unmarshal(check.Options, &options); err != nil {
		return options, &probeFailure{code: "probe_failed", message: "Invalid probe options"}
	}
	var raw map[string]map[string]json.RawMessage
	_ = json.Unmarshal(check.Options, &raw)
	has := func(section, key string) bool { _, ok := raw[section][key]; return ok }
	port := 0
	if check.Port != nil {
		port = *check.Port
	}
	switch check.CheckType {
	case "http":
		if options.HTTP == nil {
			options.HTTP = &probeHTTPOptions{}
		}
		httpOptions := options.HTTP
		if httpOptions.Method == "" {
			httpOptions.Method = "GET"
		}
		if !has("http", "expectedStatuses") {
			httpOptions.ExpectedStatuses = make([]int, 100)
			for index := range httpOptions.ExpectedStatuses {
				httpOptions.ExpectedStatuses[index] = 200 + index
			}
		}
		if !has("http", "followRedirects") {
			httpOptions.FollowRedirects = true
		}
		if !has("http", "maxRedirects") {
			httpOptions.MaxRedirects = 3
			if !httpOptions.FollowRedirects {
				httpOptions.MaxRedirects = 0
			}
		}
	case "tcp":
		if options.TCP == nil {
			options.TCP = &probeTCPOptions{}
		}
	case "dns":
		if options.DNS == nil {
			options.DNS = &probeDNSOptions{}
		}
		if options.DNS.RecordType == "" {
			options.DNS.RecordType = "A"
		}
	case "smtp":
		if options.SMTP == nil {
			options.SMTP = &probeStartTLSOptions{}
		}
		if options.SMTP.StartTLS == nil {
			value := port == 587
			options.SMTP.StartTLS = &value
		}
	case "imap":
		if options.IMAP == nil {
			options.IMAP = &probeStartTLSOptions{}
		}
		if options.IMAP.StartTLS == nil {
			value := port == 143
			options.IMAP.StartTLS = &value
		}
	}
	if err := validateProbeOptionLimits(options); err != nil {
		return options, err
	}
	return options, nil
}

var probeJSONPointerEscape = regexp.MustCompile("~[^01]|~$")

// validateProbeOptionLimits re-applies the server's option limits so the agent
// rejects out-of-range options the same way the TypeScript engine does.
func validateProbeOptionLimits(options probeOptions) *probeFailure {
	invalid := &probeFailure{code: "probe_failed", message: "Invalid probe options"}
	if http := options.HTTP; http != nil {
		switch http.Method {
		case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
		default:
			return invalid
		}
		if len(http.Body) > 65536 || (http.Method == "GET" || http.Method == "HEAD") && http.Body != "" {
			return invalid
		}
		if len(http.ExpectedStatuses) < 1 || len(http.ExpectedStatuses) > 500 {
			return invalid
		}
		for _, status := range http.ExpectedStatuses {
			if status < 100 || status > 599 {
				return invalid
			}
		}
		if http.MaxRedirects < 0 || http.MaxRedirects > 5 || !http.FollowRedirects && http.MaxRedirects != 0 {
			return invalid
		}
		if http.MaxResponseTimeMs != nil && (*http.MaxResponseTimeMs < 1 || *http.MaxResponseTimeMs > 120000) {
			return invalid
		}
		if len(http.Assertions) > 20 {
			return invalid
		}
		for _, assertion := range http.Assertions {
			if assertion.Kind == "json" && (len(assertion.Pointer) > 256 || assertion.Pointer != "" && !strings.HasPrefix(assertion.Pointer, "/") ||
				probeJSONPointerEscape.MatchString(assertion.Pointer) || strings.Count(assertion.Pointer, "/") > 16) {
				return invalid
			}
		}
	}
	if tcp := options.TCP; tcp != nil && len(tcp.BannerContains) > 1024 {
		return invalid
	}
	if dns := options.DNS; dns != nil {
		switch dns.RecordType {
		case "A", "AAAA", "CNAME", "MX", "TXT", "NS":
		default:
			return invalid
		}
		if dns.Resolver != "" && net.ParseIP(dns.Resolver) == nil || len(dns.ExpectedValues) > 128 {
			return invalid
		}
		for _, value := range dns.ExpectedValues {
			if len(value) > 1024 {
				return invalid
			}
		}
	}
	return nil
}

func validateProbeCheck(check probeCheck) *probeFailure {
	if check.CheckID < 1 || check.IntervalSeconds < 10 || check.IntervalSeconds > 86400 ||
		check.ConfirmationSeconds < 0 || check.RecoverySeconds < 0 ||
		(check.TLSMode != "strict" && check.TLSMode != "allow_self_signed") ||
		(check.CertificateErrorMode != "down" && check.CertificateErrorMode != "warning") {
		return &probeFailure{code: "probe_failed", message: "Invalid check definition"}
	}
	switch check.CheckType {
	case "http":
		target, err := url.Parse(check.Endpoint)
		if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" ||
			target.User != nil || target.Fragment != "" || check.Port != nil {
			return &probeFailure{code: "probe_failed", message: "Invalid HTTP endpoint"}
		}
		if len(check.SecretHeaders) > 0 && target.Scheme != "https" {
			return &probeFailure{code: "probe_failed", message: "Credential headers require HTTPS"}
		}
	case "tcp", "smtp", "imap":
		if check.Port == nil || *check.Port < 1 || *check.Port > 65535 || !validProbeHost(check.Endpoint) {
			return &probeFailure{code: "probe_failed", message: "Invalid network check endpoint"}
		}
	case "dns":
		if !validProbeHost(check.Endpoint) {
			return &probeFailure{code: "probe_failed", message: "Invalid DNS endpoint"}
		}
	default:
		return &probeFailure{code: "probe_failed", message: "Unsupported check type"}
	}
	return nil
}

func validProbeHost(host string) bool {
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		return true
	}
	if len(host) == 0 || len(host) > 253 || strings.ContainsAny(host, " /:@?#") {
		return false
	}
	for _, label := range strings.Split(strings.TrimSuffix(host, "."), ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, char := range label {
			if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-') {
				return false
			}
		}
	}
	return true
}

func probeHTTP(ctx context.Context, check probeCheck) (map[string]any, string, error) {
	options, err := decodeProbeOptions(check)
	if err != nil {
		return nil, "", err
	}
	httpOptions := options.HTTP
	if httpOptions == nil {
		return nil, "", &probeFailure{code: "probe_failed", message: "HTTP options are missing"}
	}
	if len(httpOptions.Body) > probeRequestLimit {
		return nil, "", &probeFailure{code: "probe_failed", message: "HTTP request exceeds 64 KiB"}
	}
	if !validProbeMethod(httpOptions.Method) {
		return nil, "", &probeFailure{code: "probe_failed", message: "HTTP method is unsupported"}
	}
	urlValue, err := url.Parse(check.Endpoint)
	if err != nil || (urlValue.Scheme != "http" && urlValue.Scheme != "https") || urlValue.Host == "" ||
		urlValue.User != nil || urlValue.Fragment != "" {
		return nil, "", &probeFailure{code: "probe_failed", message: "Invalid HTTP endpoint"}
	}
	method, body := httpOptions.Method, httpOptions.Body
	headers := make(http.Header)
	for name, value := range httpOptions.Headers {
		if invalidProbeHeader(name, value) {
			return nil, "", &probeFailure{code: "probe_failed", message: "HTTP headers are invalid"}
		}
		headers.Set(name, value)
	}
	for name, value := range check.SecretHeaders {
		if invalidProbeHeader(name, value) {
			return nil, "", &probeFailure{code: "probe_failed", message: "Secret headers are invalid"}
		}
		headers.Set(name, value)
	}
	if len(headers) > 32 || headersSize(headers) > 16<<10 {
		return nil, "", &probeFailure{code: "probe_failed", message: "HTTP headers exceed limits"}
	}
	// Only headers the check configured make a cross-origin redirect unsafe;
	// the default User-Agent added below does not.
	customHeaders := len(headers) > 0
	if headers.Get("User-Agent") == "" {
		headers.Set("User-Agent", probeUserAgent)
	}
	var warning string
	for redirects := 0; ; redirects++ {
		response, responseBody, tlsDetails, tlsWarning, requestErr := requestProbeHTTP(ctx, check, urlValue, method, body, headers)
		if requestErr != nil {
			return nil, "", requestErr
		}
		if warning == "" {
			warning = tlsWarning
		}
		details := map[string]any{
			"statusCode": response.StatusCode, "responseBytes": len(responseBody),
			"redirects": redirects, "dnsTimeMs": tlsDetails["dnsTimeMs"],
		}
		for key, value := range tlsDetails {
			if key != "dnsTimeMs" {
				details[key] = value
			}
		}
		location := response.Header.Get("Location")
		if isProbeRedirect(response.StatusCode) && location != "" && httpOptions.FollowRedirects {
			if redirects >= httpOptions.MaxRedirects {
				return nil, "", &probeFailure{code: "probe_failed", message: "HTTP redirect limit exceeded", details: details}
			}
			next, parseErr := urlValue.Parse(location)
			if parseErr != nil || (next.Scheme != "http" && next.Scheme != "https") || next.User != nil ||
				(urlValue.Scheme == "https" && next.Scheme != "https") {
				return nil, "", &probeFailure{code: "probe_failed", message: "HTTP redirect is not permitted", details: details}
			}
			if !sameProbeOrigin(next, urlValue) && (customHeaders || body != "") {
				return nil, "", &probeFailure{code: "probe_failed", message: "Cross-origin redirects with headers or body are not permitted", details: details}
			}
			if (response.StatusCode == http.StatusMovedPermanently || response.StatusCode == http.StatusFound) &&
				method != http.MethodGet && method != http.MethodHead {
				return nil, "", &probeFailure{code: "probe_failed", message: "HTTP redirect requires an explicit method-preserving response", details: details}
			}
			if response.StatusCode == http.StatusSeeOther && method != http.MethodHead {
				method, body = http.MethodGet, ""
			}
			urlValue = next
			continue
		}
		if !containsInt(httpOptions.ExpectedStatuses, response.StatusCode) {
			return nil, "", &probeFailure{code: "http_status", message: fmt.Sprintf("Unexpected HTTP status %d", response.StatusCode), details: details}
		}
		assertions := evaluateProbeAssertions(httpOptions.Assertions, responseBody, response.Header)
		details["assertions"] = assertions
		for _, assertion := range assertions {
			if !assertion.Passed {
				return nil, "", &probeFailure{code: fmt.Sprintf("assertion_failed:%d", assertion.Index), message: fmt.Sprintf("HTTP %s assertion %d failed", assertion.Kind, assertion.Index), details: details}
			}
		}
		return details, warning, nil
	}
}

func requestProbeHTTP(ctx context.Context, check probeCheck, target *url.URL, method, body string, headers http.Header) (*http.Response, []byte, map[string]any, string, error) {
	host := target.Hostname()
	port := target.Port()
	if port == "" {
		port = "80"
		if target.Scheme == "https" {
			port = "443"
		}
	}
	conn, dnsMs, err := dialProbe(ctx, host, port, check.AllowPrivate)
	if err != nil {
		return nil, nil, nil, "", err
	}
	defer conn.Close()
	details := map[string]any{"dnsTimeMs": dnsMs}
	warning := ""
	if target.Scheme == "https" {
		secure := tls.Client(conn, &tls.Config{ServerName: host, InsecureSkipVerify: true}) //nolint:gosec // Verification is performed explicitly below.
		if deadline, ok := ctx.Deadline(); ok {
			_ = secure.SetDeadline(deadline)
		}
		if err := secure.HandshakeContext(ctx); err != nil {
			return nil, nil, details, "", tlsProbeError(ctx, err)
		}
		tlsDetails, tlsWarning, verifyErr := verifyProbeTLS(check, host, secure.ConnectionState().PeerCertificates)
		for key, value := range tlsDetails {
			details[key] = value
		}
		if verifyErr != nil {
			return nil, nil, details, "", verifyErr
		}
		warning = tlsWarning
		conn = secure
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), strings.NewReader(body))
	if err != nil {
		return nil, nil, details, "", &probeFailure{code: "probe_failed", message: "Invalid HTTP request"}
	}
	request.Header = headers.Clone()
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("Connection", "close")
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if err := request.Write(conn); err != nil {
		return nil, nil, details, "", classifyProbeError(ctx, err)
	}
	bounded := &headerBoundReader{conn: conn, remaining: probeHeaderLimit + 4096}
	response, err := http.ReadResponse(bufio.NewReader(bounded), request)
	if err != nil {
		if errors.Is(err, errProbeHeaders) {
			return nil, nil, details, "", &probeFailure{code: "probe_failed", message: "HTTP response headers exceed limits"}
		}
		return nil, nil, details, "", classifyProbeError(ctx, err)
	}
	bounded.unlimited = true
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, probeResponseLimit+1))
	if err != nil {
		return nil, nil, details, "", classifyProbeError(ctx, err)
	}
	if len(responseBody) > probeResponseLimit {
		return nil, nil, details, "", &probeFailure{code: "probe_failed", message: "HTTP response exceeds 1 MiB"}
	}
	return response, responseBody, details, warning, nil
}

const probeHeaderLimit = 16 << 10

const probeUserAgent = "Robin-Admin-Monitor/1"

var errProbeHeaders = errors.New("response headers too large")

// headerBoundReader caps bytes read while the response header is parsed.
type headerBoundReader struct {
	conn      net.Conn
	remaining int
	unlimited bool
}

func (r *headerBoundReader) Read(p []byte) (int, error) {
	if r.unlimited {
		return r.conn.Read(p)
	}
	if r.remaining <= 0 {
		return 0, errProbeHeaders
	}
	if len(p) > r.remaining {
		p = p[:r.remaining]
	}
	n, err := r.conn.Read(p)
	r.remaining -= n
	return n, err
}

func probeTCP(ctx context.Context, check probeCheck) (map[string]any, string, error) {
	options, err := decodeProbeOptions(check)
	if err != nil {
		return nil, "", err
	}
	if options.TCP == nil || check.Port == nil {
		return nil, "", &probeFailure{code: "probe_failed", message: "TCP options or port are missing"}
	}
	conn, dnsMs, err := dialProbe(ctx, check.Endpoint, strconv.Itoa(*check.Port), check.AllowPrivate)
	if err != nil {
		return nil, "", err
	}
	defer conn.Close()
	details := map[string]any{"connected": true, "dnsTimeMs": dnsMs}
	warning := ""
	if options.TCP.TLS {
		secure := tls.Client(conn, &tls.Config{ServerName: check.Endpoint, InsecureSkipVerify: true}) //nolint:gosec // Verification is performed explicitly below.
		if deadline, ok := ctx.Deadline(); ok {
			_ = secure.SetDeadline(deadline)
		}
		if err := secure.HandshakeContext(ctx); err != nil {
			return nil, "", tlsProbeError(ctx, err)
		}
		tlsDetails, tlsWarning, verifyErr := verifyProbeTLS(check, check.Endpoint, secure.ConnectionState().PeerCertificates)
		if verifyErr != nil {
			return nil, "", verifyErr
		}
		for key, value := range tlsDetails {
			details[key] = value
		}
		warning = tlsWarning
		conn = secure
	}
	if options.TCP.BannerContains != "" {
		if deadline, ok := ctx.Deadline(); ok {
			_ = conn.SetReadDeadline(deadline)
		}
		banner, readErr := readProbeBanner(ctx, conn, options.TCP.BannerContains)
		if readErr != nil {
			return nil, "", readErr
		}
		details["bannerMatched"] = true
		details["bannerBytes"] = len(banner)
	}
	return details, warning, nil
}

func probeSMTP(ctx context.Context, check probeCheck) (map[string]any, string, error) {
	options, err := decodeProbeOptions(check)
	if err != nil {
		return nil, "", err
	}
	port := 25
	if check.Port != nil {
		port = *check.Port
	}
	startTLS := *options.SMTP.StartTLS
	implicitTLS := port == 465
	if implicitTLS && startTLS {
		return nil, "", &probeFailure{code: "probe_failed", message: "SMTP port 465 does not use STARTTLS"}
	}
	conn, dnsMs, err := dialProbe(ctx, check.Endpoint, strconv.Itoa(port), check.AllowPrivate)
	if err != nil {
		return nil, "", err
	}
	defer conn.Close()
	details := map[string]any{"connected": true, "dnsTimeMs": dnsMs}
	warning := ""
	if implicitTLS {
		conn, warning, details, err = upgradeProbeTLS(ctx, conn, check, check.Endpoint, details)
		if err != nil {
			return nil, "", err
		}
	}
	reader := bufio.NewReaderSize(conn, probeBannerLimit)
	budget := &probeReadBudget{}
	greeting, err := readSMTPReply(ctx, reader, budget)
	if err != nil {
		return nil, "", err
	}
	if greeting.code != 220 {
		return nil, "", &probeFailure{code: "probe_failed", message: "Unexpected mail service greeting"}
	}
	if startTLS {
		_, err = writeProbeLine(conn, "EHLO robin-agent.local")
		if err != nil {
			return nil, "", classifyProbeError(ctx, err)
		}
		hello, err := readSMTPReply(ctx, reader, budget)
		if err != nil {
			return nil, "", err
		}
		if hello.code != 250 || !hasProtocolCapability(hello.lines, "STARTTLS") {
			return nil, "", &probeFailure{code: "probe_failed", message: "SMTP server does not advertise STARTTLS"}
		}
		if reader.Buffered() != 0 {
			return nil, "", &probeFailure{code: "probe_failed", message: "Unexpected plaintext data before STARTTLS"}
		}
		_, err = writeProbeLine(conn, "STARTTLS")
		if err != nil {
			return nil, "", classifyProbeError(ctx, err)
		}
		reply, err := readSMTPReply(ctx, reader, budget)
		if err != nil {
			return nil, "", err
		}
		if reply.code != 220 || reader.Buffered() != 0 {
			return nil, "", &probeFailure{code: "probe_failed", message: "SMTP STARTTLS command failed"}
		}
		conn, warning, details, err = upgradeProbeTLS(ctx, conn, check, check.Endpoint, details)
		if err != nil {
			return nil, "", err
		}
		reader = bufio.NewReaderSize(conn, probeBannerLimit)
		_, err = writeProbeLine(conn, "EHLO robin-agent.local")
		if err != nil {
			return nil, "", classifyProbeError(ctx, err)
		}
		hello, err = readSMTPReply(ctx, reader, budget)
		if err != nil {
			return nil, "", err
		}
		if hello.code != 250 {
			return nil, "", &probeFailure{code: "probe_failed", message: "SMTP EHLO command failed after STARTTLS"}
		}
	}
	return details, warning, nil
}

var imapGreetingPattern = regexp.MustCompile(`(?i)^\*\s+(?:OK|PREAUTH)\b`)

func probeIMAP(ctx context.Context, check probeCheck) (map[string]any, string, error) {
	options, err := decodeProbeOptions(check)
	if err != nil {
		return nil, "", err
	}
	port := 993
	if check.Port != nil {
		port = *check.Port
	}
	startTLS := *options.IMAP.StartTLS
	implicitTLS := port != 143 && !startTLS
	if port == 993 && startTLS {
		return nil, "", &probeFailure{code: "probe_failed", message: "IMAP port 993 does not use STARTTLS"}
	}
	conn, dnsMs, err := dialProbe(ctx, check.Endpoint, strconv.Itoa(port), check.AllowPrivate)
	if err != nil {
		return nil, "", err
	}
	defer conn.Close()
	details := map[string]any{"connected": true, "dnsTimeMs": dnsMs}
	warning := ""
	if implicitTLS {
		conn, warning, details, err = upgradeProbeTLS(ctx, conn, check, check.Endpoint, details)
		if err != nil {
			return nil, "", err
		}
	}
	reader := bufio.NewReaderSize(conn, probeBannerLimit)
	budget := &probeReadBudget{}
	greeting, err := readProbeLine(ctx, reader, budget)
	if err != nil {
		return nil, "", err
	}
	if !imapGreetingPattern.MatchString(greeting) {
		return nil, "", &probeFailure{code: "probe_failed", message: "Unexpected mail service greeting"}
	}
	if startTLS {
		if reader.Buffered() != 0 {
			return nil, "", &probeFailure{code: "probe_failed", message: "Unexpected plaintext data before STARTTLS"}
		}
		_, err = writeProbeLine(conn, "A001 CAPABILITY")
		if err != nil {
			return nil, "", classifyProbeError(ctx, err)
		}
		capability, err := readIMAPReply(ctx, reader, budget, "A001")
		if err != nil {
			return nil, "", err
		}
		if !capability.ok || !hasIMAPCapability(capability.lines, "STARTTLS") {
			return nil, "", &probeFailure{code: "probe_failed", message: "IMAP server does not advertise STARTTLS"}
		}
		if reader.Buffered() != 0 {
			return nil, "", &probeFailure{code: "probe_failed", message: "Unexpected plaintext data before STARTTLS"}
		}
		_, err = writeProbeLine(conn, "A002 STARTTLS")
		if err != nil {
			return nil, "", classifyProbeError(ctx, err)
		}
		reply, err := readIMAPReply(ctx, reader, budget, "A002")
		if err != nil {
			return nil, "", err
		}
		if !reply.ok || reader.Buffered() != 0 {
			return nil, "", &probeFailure{code: "probe_failed", message: "IMAP STARTTLS command failed"}
		}
		conn, warning, details, err = upgradeProbeTLS(ctx, conn, check, check.Endpoint, details)
		if err != nil {
			return nil, "", err
		}
	}
	return details, warning, nil
}

func probeDNS(ctx context.Context, check probeCheck) (map[string]any, string, error) {
	options, err := decodeProbeOptions(check)
	if err != nil {
		return nil, "", err
	}
	if options.DNS == nil {
		return nil, "", &probeFailure{code: "probe_failed", message: "DNS options are missing"}
	}
	resolver := net.DefaultResolver
	if options.DNS.Resolver != "" {
		if net.ParseIP(options.DNS.Resolver) == nil || !permittedProbeAddress(options.DNS.Resolver, check.AllowPrivate) {
			return nil, "", &probeFailure{code: "target_not_permitted", message: "DNS resolver address is not permitted"}
		}
		port := 53
		if check.Port != nil {
			port = *check.Port
		}
		resolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(options.DNS.Resolver, strconv.Itoa(port)))
		}}
	}
	started := time.Now()
	values, err := lookupProbeRecords(ctx, resolver, check.Endpoint, options.DNS.RecordType)
	dnsMs := time.Since(started).Milliseconds()
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, "", &probeFailure{code: "probe_timeout", message: "Probe timed out", details: map[string]any{"dnsTimeMs": dnsMs}}
		}
		return nil, "", &probeFailure{code: "dns_failed", message: "DNS resolution failed", details: map[string]any{"dnsTimeMs": dnsMs}}
	}
	if len(values) == 0 || len(values) > probeDNSLimit {
		return nil, "", &probeFailure{code: "dns_failed", message: "DNS response is empty or exceeds record limits", details: map[string]any{"dnsTimeMs": dnsMs}}
	}
	actual := map[string]bool{}
	for _, value := range values {
		if len(value) > 1024 {
			return nil, "", &probeFailure{code: "dns_failed", message: "DNS response is empty or exceeds record limits", details: map[string]any{"dnsTimeMs": dnsMs}}
		}
		actual[normalizeProbeDNS(options.DNS.RecordType, value)] = true
	}
	for _, expected := range options.DNS.ExpectedValues {
		if !actual[normalizeProbeDNS(options.DNS.RecordType, expected)] {
			return nil, "", &probeFailure{code: "probe_failed", message: "Expected DNS record is missing", details: map[string]any{"dnsTimeMs": dnsMs}}
		}
	}
	return map[string]any{"recordType": options.DNS.RecordType, "recordCount": len(values), "expectedRecordCount": len(options.DNS.ExpectedValues), "dnsTimeMs": dnsMs}, "", nil
}

func lookupProbeRecords(ctx context.Context, resolver *net.Resolver, host, recordType string) ([]string, error) {
	switch recordType {
	case "A", "AAAA":
		addresses, err := resolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		out := []string{}
		for _, address := range addresses {
			if recordType == "A" && address.IP.To4() != nil {
				out = append(out, address.IP.String())
			} else if recordType == "AAAA" && address.IP.To4() == nil {
				out = append(out, address.IP.String())
			}
		}
		return out, nil
	case "CNAME":
		value, err := resolver.LookupCNAME(ctx, host)
		if err != nil || normalizeProbeDNS("CNAME", value) == normalizeProbeDNS("CNAME", host) {
			return nil, err
		}
		return []string{value}, nil
	case "MX":
		values, err := resolver.LookupMX(ctx, host)
		out := make([]string, 0, len(values))
		for _, value := range values {
			out = append(out, fmt.Sprintf("%d %s", value.Pref, value.Host))
		}
		return out, err
	case "TXT":
		return resolver.LookupTXT(ctx, host)
	case "NS":
		values, err := resolver.LookupNS(ctx, host)
		out := make([]string, 0, len(values))
		for _, value := range values {
			out = append(out, value.Host)
		}
		return out, err
	default:
		return nil, errors.New("unsupported DNS record type")
	}
}

func normalizeProbeDNS(recordType, value string) string {
	if strings.EqualFold(recordType, "TXT") {
		return value
	}
	if strings.EqualFold(recordType, "A") || strings.EqualFold(recordType, "AAAA") {
		if ip := net.ParseIP(value); ip != nil {
			return ip.String()
		}
		return value
	}
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(value)), ".")
}

type probeHostResolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

func dialProbe(ctx context.Context, host, port string, allowPrivate bool) (net.Conn, int64, error) {
	return dialProbeWith(ctx, host, port, allowPrivate, net.DefaultResolver, (&net.Dialer{}).DialContext)
}

func dialProbeWith(ctx context.Context, host, port string, allowPrivate bool, resolver probeHostResolver, dial func(context.Context, string, string) (net.Conn, error)) (net.Conn, int64, error) {
	started := time.Now()
	addresses, err := resolveProbeAddressesWith(ctx, resolver, host, allowPrivate)
	dnsMs := time.Since(started).Milliseconds()
	if err != nil {
		return nil, dnsMs, withProbeDNSDuration(err, dnsMs)
	}
	if timing, ok := ctx.Value(probeTimingKey{}).(*probeTiming); ok {
		timing.mark()
	}
	var last error
	for index, address := range addresses {
		attemptCtx := ctx
		cancel := func() {}
		if deadline, ok := ctx.Deadline(); ok && len(addresses)-index > 1 {
			remaining := time.Until(deadline)
			budget := remaining / time.Duration(len(addresses)-index)
			if budget > 3*time.Second {
				budget = 3 * time.Second
			}
			if budget <= 0 {
				break
			}
			attemptCtx, cancel = context.WithTimeout(ctx, budget)
		}
		conn, dialErr := dial(attemptCtx, "tcp", net.JoinHostPort(address, port))
		cancel()
		if dialErr == nil {
			if deadline, ok := ctx.Deadline(); ok {
				_ = conn.SetDeadline(deadline)
			}
			context.AfterFunc(ctx, func() { _ = conn.Close() })
			return conn, dnsMs, nil
		}
		last = dialErr
	}
	return nil, dnsMs, withProbeDNSDuration(classifyProbeError(ctx, last), dnsMs)
}

func withProbeDNSDuration(err error, dnsMs int64) error {
	var failure *probeFailure
	if !errors.As(err, &failure) {
		failure = classifyProbeError(context.Background(), err)
	}
	details := make(map[string]any, len(failure.details)+1)
	for key, value := range failure.details {
		details[key] = value
	}
	details["dnsTimeMs"] = dnsMs
	return &probeFailure{code: failure.code, message: failure.message, details: details, warning: failure.warning}
}

func resolveProbeAddresses(ctx context.Context, host string, allowPrivate bool) ([]string, error) {
	return resolveProbeAddressesWith(ctx, net.DefaultResolver, host, allowPrivate)
}

func resolveProbeAddressesWith(ctx context.Context, resolver probeHostResolver, host string, allowPrivate bool) ([]string, error) {
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		if !permittedProbeAddress(ip.String(), allowPrivate) {
			return nil, &probeFailure{code: "target_not_permitted", message: "Target address is not permitted"}
		}
		return []string{ip.String()}, nil
	}
	addresses, err := resolver.LookupIPAddr(ctx, host)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, &probeFailure{code: "probe_timeout", message: "Probe timed out"}
		}
		return nil, &probeFailure{code: "dns_failed", message: "Target DNS resolution failed"}
	}
	if len(addresses) == 0 || len(addresses) > probeDNSLimit {
		return nil, &probeFailure{code: "dns_failed", message: "Target DNS resolution failed"}
	}
	out := make([]string, 0, len(addresses))
	for _, address := range addresses {
		if !permittedProbeAddress(address.IP.String(), allowPrivate) {
			return nil, &probeFailure{code: "target_not_permitted", message: "Target address is not permitted"}
		}
		out = append(out, address.IP.String())
	}
	return out, nil
}

// Address policy mirrors ipaddr.js "unicast" in the TypeScript engine: only globally routable
// addresses are permitted, plus private, unique-local and loopback ranges when allowPrivate is set.
var (
	probePublicDenied = mustParseCIDRs("0.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "192.175.48.0/24", "192.31.196.0/24", "192.52.193.0/24",
		"::/128", "fe80::/10", "ff00::/8", "fec0::/10", "100::/64", "::ffff:0:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "2002::/16", "2001::/23", "2001:db8::/32", "2001:4:112::/48", "2620:4f:8000::/48",
		"2001:10::/28", "2001:20::/28", "2001:30::/28", "5f00::/16", "3fff::/20", "fd00:ec2::254/128")
	probePrivateAllowed = mustParseCIDRs("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "::1/128", "fc00::/7")
)

func mustParseCIDRs(blocks ...string) []*net.IPNet {
	networks := make([]*net.IPNet, 0, len(blocks))
	for _, block := range blocks {
		_, network, err := net.ParseCIDR(block)
		if err != nil {
			panic(err)
		}
		networks = append(networks, network)
	}
	return networks
}

func probeAddressInAny(ip net.IP, networks []*net.IPNet) bool {
	for _, network := range networks {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func permittedProbeAddress(value string, allowPrivate bool) bool {
	ip := net.ParseIP(value)
	if ip == nil {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil {
		ip = ip4
	}
	if probeAddressInAny(ip, probePublicDenied) {
		return false
	}
	if probeAddressInAny(ip, probePrivateAllowed) {
		return allowPrivate
	}
	return true
}

func invalidProbeHeader(name, value string) bool {
	lower := strings.ToLower(name)
	if name == "" || len(name) > 128 || strings.ContainsAny(value, "\r\n") || len(value) > 4096 {
		return true
	}
	for _, char := range name {
		if char <= 32 || char >= 127 || strings.ContainsRune("()<>@,;:\\\"/[]?={} \t", char) {
			return true
		}
	}
	for _, reserved := range []string{"host", "connection", "content-length", "transfer-encoding", "upgrade", "te", "trailer", "accept-encoding"} {
		if lower == reserved || strings.HasPrefix(lower, "proxy-") {
			return true
		}
	}
	return false
}

func headersSize(headers http.Header) int {
	total := 0
	for name, values := range headers {
		for _, value := range values {
			total += len(name) + len(value) + 4
		}
	}
	return total
}

func verifyProbeTLS(check probeCheck, host string, certificates []*x509.Certificate) (map[string]any, string, error) {
	details := map[string]any{}
	if len(certificates) == 0 {
		return details, "", &probeFailure{code: "tls_certificate_error", message: "TLS certificate is missing", details: map[string]any{"certificateError": true}, warning: check.CertificateErrorMode == "warning"}
	}
	certificate := certificates[0]
	expiration := certificate.NotAfter
	days := int(time.Until(expiration).Hours() / 24)
	details["tlsAuthorized"] = true
	details["tlsTrustedLocalCertificate"] = false
	details["certDaysRemaining"] = days
	details["certValidTo"] = expiration.UTC().Format(time.RFC3339)
	certificateFailure := func(message string) (map[string]any, string, error) {
		details["tlsAuthorized"] = false
		details["certificateError"] = true
		return details, "", &probeFailure{code: "tls_certificate_error", message: message, details: details, warning: check.CertificateErrorMode == "warning"}
	}
	if err := certificate.VerifyHostname(host); err != nil {
		return certificateFailure("TLS certificate hostname does not match target")
	}
	now := time.Now()
	if now.Before(certificate.NotBefore) || now.After(certificate.NotAfter) {
		return certificateFailure("TLS certificate is expired or not yet valid")
	}
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		roots = x509.NewCertPool()
	}
	intermediates := x509.NewCertPool()
	for _, intermediate := range certificates[1:] {
		intermediates.AddCert(intermediate)
	}
	_, verifyErr := certificate.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, DNSName: host, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	if verifyErr != nil {
		var unknownAuthority x509.UnknownAuthorityError
		if check.TLSMode == "allow_self_signed" && errors.As(verifyErr, &unknownAuthority) {
			details["tlsAuthorized"] = false
			details["tlsTrustedLocalCertificate"] = true
		} else {
			return certificateFailure("TLS certificate verification failed")
		}
	}
	if check.CertExpiryDays != nil && days <= *check.CertExpiryDays {
		return details, fmt.Sprintf("Certificate expires in %d days", days), nil
	}
	return details, "", nil
}

func tlsProbeError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &probeFailure{code: "probe_timeout", message: "Probe timed out"}
	}
	var networkErr net.Error
	if errors.As(err, &networkErr) && networkErr.Timeout() {
		return &probeFailure{code: "probe_timeout", message: "Probe timed out"}
	}
	return classifyProbeError(ctx, err)
}

func sameProbeOrigin(left, right *url.URL) bool {
	port := func(value *url.URL) string {
		if value.Port() != "" {
			return value.Port()
		}
		if value.Scheme == "https" {
			return "443"
		}
		return "80"
	}
	return strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Hostname(), right.Hostname()) && port(left) == port(right)
}

func upgradeProbeTLS(ctx context.Context, conn net.Conn, check probeCheck, host string, details map[string]any) (net.Conn, string, map[string]any, error) {
	secure := tls.Client(conn, &tls.Config{ServerName: host, InsecureSkipVerify: true}) //nolint:gosec // Verification is performed explicitly below.
	if deadline, ok := ctx.Deadline(); ok {
		_ = secure.SetDeadline(deadline)
	}
	if err := secure.HandshakeContext(ctx); err != nil {
		return nil, "", details, tlsProbeError(ctx, err)
	}
	tlsDetails, warning, err := verifyProbeTLS(check, host, secure.ConnectionState().PeerCertificates)
	for key, value := range tlsDetails {
		details[key] = value
	}
	return secure, warning, details, err
}

func readProbeBanner(ctx context.Context, conn net.Conn, expected string) ([]byte, error) {
	var result []byte
	buffer := make([]byte, 1024)
	for len(result) <= probeBannerLimit {
		n, err := conn.Read(buffer)
		if n > 0 {
			result = append(result, buffer[:n]...)
			if bytes.Contains(result, []byte(expected)) {
				return result, nil
			}
			if bytes.Contains(result, []byte("\n")) && expected == "" {
				return result, nil
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, &probeFailure{code: "probe_failed", message: "Banner assertion failed"}
			}
			return nil, classifyProbeError(ctx, err)
		}
	}
	return nil, &probeFailure{code: "probe_failed", message: "Service banner exceeds 8 KiB"}
}

type probeReadBudget struct {
	bytes int
}

func readProbeLine(ctx context.Context, reader *bufio.Reader, budget *probeReadBudget) (string, error) {
	line, err := reader.ReadSlice('\n')
	budget.bytes += len(line)
	if budget.bytes > probeBannerLimit || errors.Is(err, bufio.ErrBufferFull) {
		return "", &probeFailure{code: "probe_failed", message: "Mail protocol response exceeds 8 KiB"}
	}
	if err != nil {
		return "", classifyProbeError(ctx, err)
	}
	return strings.TrimSuffix(strings.TrimSuffix(string(line), "\n"), "\r"), nil
}

type smtpReply struct {
	code  int
	lines []string
}

func readSMTPReply(ctx context.Context, reader *bufio.Reader, budget *probeReadBudget) (smtpReply, error) {
	first, err := readProbeLine(ctx, reader, budget)
	if err != nil {
		return smtpReply{}, err
	}
	if len(first) < 3 {
		return smtpReply{}, &probeFailure{code: "probe_failed", message: "Invalid SMTP response"}
	}
	code, parseErr := strconv.Atoi(first[:3])
	if parseErr != nil {
		return smtpReply{}, &probeFailure{code: "probe_failed", message: "Invalid SMTP response"}
	}
	if len(first) > 3 && first[3] != ' ' && first[3] != '-' {
		return smtpReply{}, &probeFailure{code: "probe_failed", message: "Invalid SMTP response"}
	}
	result := smtpReply{code: code, lines: []string{first}}
	for len(first) > 3 && first[3] == '-' {
		if len(result.lines) >= 128 {
			return smtpReply{}, &probeFailure{code: "probe_failed", message: "SMTP response contains too many lines"}
		}
		first, err = readProbeLine(ctx, reader, budget)
		if err != nil {
			return smtpReply{}, err
		}
		if !strings.HasPrefix(first, fmt.Sprintf("%03d", code)) || len(first) > 3 && first[3] != ' ' && first[3] != '-' {
			return smtpReply{}, &probeFailure{code: "probe_failed", message: "Invalid SMTP response"}
		}
		result.lines = append(result.lines, first)
	}
	return result, nil
}

type imapReply struct {
	ok    bool
	lines []string
}

func readIMAPReply(ctx context.Context, reader *bufio.Reader, budget *probeReadBudget, tag string) (imapReply, error) {
	result := imapReply{}
	for len(result.lines) < 128 {
		line, err := readProbeLine(ctx, reader, budget)
		if err != nil {
			return imapReply{}, err
		}
		result.lines = append(result.lines, line)
		fields := strings.Fields(line)
		if len(fields) >= 2 && strings.EqualFold(fields[0], tag) {
			result.ok = strings.EqualFold(fields[1], "OK")
			return result, nil
		}
	}
	return imapReply{}, &probeFailure{code: "probe_failed", message: "IMAP response contains too many lines"}
}

func writeProbeLine(writer io.Writer, line string) (int, error) {
	if strings.ContainsAny(line, "\r\n") {
		return 0, errors.New("invalid protocol command")
	}
	return io.WriteString(writer, line+"\r\n")
}

func hasProtocolCapability(lines []string, capability string) bool {
	for _, line := range lines {
		if len(line) >= 4 && line[0] >= '0' && line[0] <= '9' && (line[3] == '-' || line[3] == ' ') {
			line = line[4:]
		}
		for _, field := range strings.Fields(line) {
			if strings.EqualFold(strings.Trim(field, "[]"), capability) {
				return true
			}
		}
	}
	return false
}

// hasIMAPCapability only honours untagged "* CAPABILITY ..." lines, as the TypeScript engine does.
func hasIMAPCapability(lines []string, capability string) bool {
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != "*" || !strings.EqualFold(fields[1], "CAPABILITY") {
			continue
		}
		for _, field := range fields[2:] {
			if strings.EqualFold(field, capability) {
				return true
			}
		}
	}
	return false
}

type probeAssertionResult struct {
	Index  int    `json:"index"`
	Kind   string `json:"kind"`
	Passed bool   `json:"passed"`
}

func evaluateProbeAssertions(assertions []probeAssertion, body []byte, headers http.Header) []probeAssertionResult {
	out := make([]probeAssertionResult, 0, len(assertions))
	var jsonBody any
	jsonParsed := json.Unmarshal(body, &jsonBody) == nil
	for index, assertion := range assertions {
		var actual any
		present := true
		switch assertion.Kind {
		case "body":
			actual = string(body)
		case "header":
			values, ok := headers[http.CanonicalHeaderKey(assertion.Name)]
			present = ok && len(values) > 0
			if present {
				actual = strings.Join(values, ", ")
			}
		case "json":
			actual = jsonBody
			present = jsonParsed
			pointer := assertion.Pointer
			if pointer != "" && !strings.HasPrefix(pointer, "/") {
				present = false
			}
			for _, part := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
				if pointer == "" {
					break
				}
				part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
				if !present {
					present = false
					break
				}
				switch container := actual.(type) {
				case map[string]any:
					actual, present = container[part]
				case []any:
					position, err := strconv.Atoi(part)
					if err != nil || position < 0 || position >= len(container) {
						present = false
					} else {
						actual = container[position]
					}
				default:
					present = false
				}
			}
		}
		expected, expectedErr := decodeAssertionValue(assertion.Value)
		passed := present && (assertion.Operator == "exists" || expectedErr == nil && compareProbeAssertion(actual, expected, assertion.Operator))
		out = append(out, probeAssertionResult{Index: index + 1, Kind: assertion.Kind, Passed: passed})
	}
	return out
}

func decodeAssertionValue(raw json.RawMessage) (any, error) {
	var value any
	err := json.Unmarshal(raw, &value)
	return value, err
}

func compareProbeAssertion(actual, expected any, operator string) bool {
	actualString, actualIsString := actual.(string)
	expectedString, expectedIsString := expected.(string)
	switch operator {
	case "exists":
		return true
	case "equals":
		return fmt.Sprint(actual) == fmt.Sprint(expected) && fmt.Sprintf("%T", actual) == fmt.Sprintf("%T", expected)
	case "not_equals":
		return !(fmt.Sprint(actual) == fmt.Sprint(expected) && fmt.Sprintf("%T", actual) == fmt.Sprintf("%T", expected))
	case "contains":
		return actualIsString && expectedIsString && strings.Contains(actualString, expectedString)
	case "not_contains":
		return actualIsString && expectedIsString && !strings.Contains(actualString, expectedString)
	case "gt", "gte", "lt", "lte":
		actualNumber, actualOK := actual.(float64)
		expectedNumber, expectedOK := expected.(float64)
		if !actualOK || !expectedOK {
			return false
		}
		switch operator {
		case "gt":
			return actualNumber > expectedNumber
		case "gte":
			return actualNumber >= expectedNumber
		case "lt":
			return actualNumber < expectedNumber
		default:
			return actualNumber <= expectedNumber
		}
	}
	return false
}

func validProbeMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions:
		return true
	default:
		return false
	}
}

func isProbeRedirect(status int) bool {
	return status == http.StatusMovedPermanently || status == http.StatusFound ||
		status == http.StatusSeeOther || status == http.StatusTemporaryRedirect ||
		status == http.StatusPermanentRedirect
}

func containsInt(values []int, wanted int) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func numberAsInt64(value any) int64 {
	switch number := value.(type) {
	case int64:
		return number
	case int:
		return int64(number)
	case float64:
		return int64(number)
	default:
		return 0
	}
}
