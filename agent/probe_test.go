package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestSharedProbeConformanceCases(t *testing.T) {
	data, err := os.ReadFile("../contracts/monitoring-probe-v1/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		ProtocolVersion int `json:"protocolVersion"`
		Cases           []struct {
			ID      string `json:"id"`
			Fixture struct {
				Type              string              `json:"type"`
				Status            int                 `json:"status"`
				Body              string              `json:"body"`
				Hang              bool                `json:"hang"`
				Banner            string              `json:"banner"`
				CloseAfterWrite   bool                `json:"closeAfterWrite"`
				Replies           []string            `json:"replies"`
				Records           map[string][]string `json:"records"`
				Port              int                 `json:"port"`
				RCode             int                 `json:"rcode"`
				HangAfterReplies  bool                `json:"hangAfterReplies"`
				Cert              string              `json:"cert"`
				DripMs            int                 `json:"dripMs"`
				UpgradeAfterReply int                 `json:"upgradeAfterReply"`
				Routes            map[string]struct {
					Status         int               `json:"status"`
					Headers        map[string]string `json:"headers"`
					Body           string            `json:"body"`
					BodyBytes      int               `json:"bodyBytes"`
					HeaderBytes    int               `json:"headerBytes"`
					Method         string            `json:"method"`
					RequestHeaders map[string]string `json:"requestHeaders"`
				} `json:"routes"`
			} `json:"fixture"`
			Check struct {
				CheckType            string            `json:"checkType"`
				Endpoint             string            `json:"endpoint"`
				Port                 *int              `json:"port"`
				ExpectedStatuses     []int             `json:"expectedStatuses"`
				TimeoutSeconds       int               `json:"timeoutSeconds"`
				Options              json.RawMessage   `json:"options"`
				AllowPrivate         *bool             `json:"allowPrivate"`
				SecretHeaders        map[string]string `json:"secretHeaders"`
				TLSMode              string            `json:"tlsMode"`
				CertExpiryDays       *int              `json:"certExpiryDays"`
				CertificateErrorMode string            `json:"certificateErrorMode"`
			} `json:"check"`
			Expected struct {
				Status    string  `json:"status"`
				ErrorCode *string `json:"errorCode"`
			} `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	if contract.ProtocolVersion != 1 || len(contract.Cases) == 0 {
		t.Fatalf("invalid shared contract: version=%d, cases=%d", contract.ProtocolVersion, len(contract.Cases))
	}
	for _, testCase := range contract.Cases {
		t.Run(testCase.ID, func(t *testing.T) {
			timeoutSeconds := testCase.Check.TimeoutSeconds
			if timeoutSeconds == 0 {
				timeoutSeconds = 2
			}
			check := probeCheck{
				CheckID: 1, Name: testCase.ID, CheckType: testCase.Check.CheckType, IntervalSeconds: 60,
				TimeoutSeconds: timeoutSeconds, TLSMode: "strict",
				CertificateErrorMode: "down", SecretHeaders: testCase.Check.SecretHeaders, AllowPrivate: testCase.Check.AllowPrivate == nil || *testCase.Check.AllowPrivate,
			}
			if testCase.Check.TLSMode != "" {
				check.TLSMode = testCase.Check.TLSMode
			}
			if testCase.Check.CertificateErrorMode != "" {
				check.CertificateErrorMode = testCase.Check.CertificateErrorMode
			}
			check.CertExpiryDays = testCase.Check.CertExpiryDays
			switch testCase.Fixture.Type {
			case "http", "https":
				server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if testCase.Fixture.Hang {
						<-r.Context().Done()
						return
					}
					if route, ok := testCase.Fixture.Routes[r.URL.Path]; ok {
						if route.Method != "" && route.Method != r.Method {
							w.WriteHeader(http.StatusBadRequest)
							return
						}
						for name, value := range route.RequestHeaders {
							if r.Header.Get(name) != value {
								w.WriteHeader(http.StatusUnauthorized)
								return
							}
						}
						for name, value := range route.Headers {
							w.Header().Set(name, value)
						}
						if route.HeaderBytes > 0 {
							w.Header().Set("X-Padding", strings.Repeat("a", route.HeaderBytes))
						}
						w.WriteHeader(route.Status)
						_, _ = fmt.Fprint(w, route.Body)
						if route.BodyBytes > 0 {
							_, _ = w.Write(bytes.Repeat([]byte("a"), route.BodyBytes))
						}
						return
					}
					status := testCase.Fixture.Status
					if status == 0 {
						status = http.StatusOK
					}
					w.WriteHeader(status)
					_, _ = fmt.Fprint(w, testCase.Fixture.Body)
				}))
				if testCase.Fixture.Type == "https" {
					certificate := loadFixtureCertificate(t, testCase.Fixture.Cert)
					server.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}}
					server.StartTLS()
				} else {
					server.Start()
				}
				defer server.Close()
				check.Endpoint = server.URL
				expectedStatuses := testCase.Check.ExpectedStatuses
				if len(expectedStatuses) == 0 {
					expectedStatuses = []int{http.StatusOK}
				}
				check.Options = testCase.Check.Options
				if len(check.Options) == 0 {
					check.Options, _ = json.Marshal(map[string]any{"http": map[string]any{
						"method": "GET", "headers": map[string]string{}, "body": "",
						"expectedStatuses": expectedStatuses, "followRedirects": true, "maxRedirects": 3,
						"maxResponseTimeMs": nil, "assertions": []any{},
					}})
				}
			case "dns":
				port := startProbeDNSFixture(t, testCase.Fixture.Records, testCase.Fixture.RCode, testCase.Fixture.Hang)
				check.Endpoint = testCase.Check.Endpoint
				check.Port = &port
				check.Options = testCase.Check.Options
			case "tcp", "smtp", "smtps", "imap", "imaps":
				host, port := startProbeTCPFixture(t, testCase.Fixture.Port, testCase.Fixture.Type == "imaps" || testCase.Fixture.Type == "smtps", testCase.Fixture.Banner, testCase.Fixture.CloseAfterWrite, testCase.Fixture.Replies, testCase.Fixture.DripMs, testCase.Fixture.Cert, testCase.Fixture.UpgradeAfterReply)
				check.Endpoint = host
				check.Port = &port
				if testCase.Check.Endpoint != "" {
					check.Endpoint = testCase.Check.Endpoint
					check.Port = testCase.Check.Port
				}
				check.Options = testCase.Check.Options
			default:
				t.Fatalf("unsupported fixture type %q", testCase.Fixture.Type)
			}
			result := runProbe(context.Background(), check)
			if result.Status != testCase.Expected.Status {
				t.Fatalf("status = %q, want %q (error=%q)", result.Status, testCase.Expected.Status, result.Warning)
			}
			if testCase.Expected.ErrorCode == nil {
				if result.ErrorCode != "" {
					t.Fatalf("error code = %q, want none", result.ErrorCode)
				}
			} else if result.ErrorCode != *testCase.Expected.ErrorCode {
				t.Fatalf("error code = %q, want %q", result.ErrorCode, *testCase.Expected.ErrorCode)
			}
		})
	}
}

func startProbeTCPFixture(t *testing.T, fixedPort int, useTLS bool, banner string, closeAfterWrite bool, replies []string, dripMs int, cert string, upgradeAfter int) (string, int) {
	t.Helper()
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", fixedPort))
	if err != nil {
		if fixedPort != 0 {
			t.Skipf("fixture port %d cannot be bound here: %v", fixedPort, err)
		}
		t.Fatal(err)
	}
	if useTLS {
		certificate := loadFixtureCertificate(t, cert)
		listener = tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{certificate}})
	}
	t.Cleanup(func() { _ = listener.Close() })
	port := listener.Addr().(*net.TCPAddr).Port
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		if dripMs > 0 {
			for i := 0; i < len(banner); i++ {
				if _, writeErr := fmt.Fprint(conn, banner[i:i+1]); writeErr != nil {
					return
				}
				time.Sleep(time.Duration(dripMs) * time.Millisecond)
			}
			return
		}
		_, _ = fmt.Fprint(conn, banner)
		if closeAfterWrite {
			return
		}
		reader := bufio.NewReader(conn)
		for index, reply := range replies {
			if _, readErr := reader.ReadString(10); readErr != nil {
				return
			}
			_, _ = fmt.Fprint(conn, reply)
			if index+1 == upgradeAfter {
				secure := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{loadFixtureCertificate(t, cert)}})
				_ = secure.Handshake()
				conn = secure
				reader = bufio.NewReader(conn)
			}
		}
		time.Sleep(3 * time.Second)
	}()
	return "127.0.0.1", port
}

func loadFixtureCertificate(t *testing.T, variant string) tls.Certificate {
	t.Helper()
	prefix := "tls"
	if variant != "" {
		prefix = "tls-" + variant
	}
	certificate, err := tls.LoadX509KeyPair("../contracts/monitoring-probe-v1/fixtures/"+prefix+"-cert.pem", "../contracts/monitoring-probe-v1/fixtures/"+prefix+"-key.pem")
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}

type fixtureProbeResolver struct {
	addresses []net.IPAddr
}

func (r fixtureProbeResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return r.addresses, nil
}

func TestProbeConnectFallsBackAfterHangingAddress(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	accepted := make(chan struct{})
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr == nil {
			close(accepted)
			_ = conn.Close()
		}
	}()
	resolver := fixtureProbeResolver{addresses: []net.IPAddr{
		{IP: net.ParseIP("::1")},
		{IP: net.ParseIP("127.0.0.1")},
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		if strings.HasPrefix(address, "[::1]:") {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	started := time.Now()
	conn, _, err := dialProbeWith(ctx, "fixture.test", fmt.Sprint(port), true, resolver, dial)
	if err != nil {
		t.Fatalf("fallback address should connect: %v", err)
	}
	defer conn.Close()
	if time.Since(started) >= 1500*time.Millisecond {
		t.Fatalf("fallback waited for the full deadline: %s", time.Since(started))
	}
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("IPv4 fallback was never attempted")
	}
}

func TestProbeClassifiesConnectionRefusal(t *testing.T) {
	failure := classifyProbeError(context.Background(), syscall.ECONNREFUSED)
	if failure.code != "connect_refused" {
		t.Fatalf("connection refusal code = %q", failure.code)
	}
}

func TestProbeTLSVerificationAndCertificateWarning(t *testing.T) {
	server := newProbeTLSServer(t, newProbeTestCertificate(t, time.Now().Add(24*time.Hour)))
	defer server.Close()

	options, _ := json.Marshal(map[string]any{"http": map[string]any{
		"method": "GET", "headers": map[string]string{}, "body": "",
		"expectedStatuses": []int{http.StatusOK}, "followRedirects": true, "maxRedirects": 3,
		"maxResponseTimeMs": nil, "assertions": []any{},
	}})
	check := probeCheck{
		CheckID: 1, Name: "tls-fixture", CheckType: "http", Endpoint: server.URL,
		IntervalSeconds: 60, TimeoutSeconds: 2, TLSMode: "strict",
		CertificateErrorMode: "down", AllowPrivate: true, Options: options,
	}
	strict := runProbe(context.Background(), check)
	if strict.Status != "down" || strict.ErrorCode != "tls_certificate_error" {
		t.Fatalf("strict self-signed TLS result = %#v", strict)
	}
	check.TLSMode = "allow_self_signed"
	trustedLocal := runProbe(context.Background(), check)
	if trustedLocal.Status != "up" || trustedLocal.Details["tlsTrustedLocalCertificate"] != true {
		t.Fatalf("allowed self-signed TLS result = %#v", trustedLocal)
	}
	expiringServer := newProbeTLSServer(t, newProbeTestCertificate(t, time.Now().Add(12*time.Hour)))
	defer expiringServer.Close()
	check.Endpoint = expiringServer.URL
	check.CertExpiryDays = intPointer(2)
	warning := runProbe(context.Background(), check)
	if warning.Status != "warning" || warning.Warning == "" || warning.ErrorCode != "" {
		t.Fatalf("certificate expiry warning result = %#v", warning)
	}
}

func newProbeTLSServer(t *testing.T, certificate tls.Certificate) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, "secure")
	}))
	server.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}}
	server.StartTLS()
	return server
}

func newProbeTestCertificate(t *testing.T, notAfter time.Time) tls.Certificate {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter,
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:    []string{"localhost"},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: template}
}

func intPointer(value int) *int { return &value }

func TestPassingProbeObservationOmitsEmptyErrorCode(t *testing.T) {
	encoded, err := json.Marshal(remoteProbeObservation{CheckID: 1, Status: "up"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "errorCode") || strings.Contains(string(encoded), "warning") {
		t.Fatalf("passing observation must omit empty errorCode and warning: %s", encoded)
	}
}

func TestPermittedProbeAddressBlocksTunnelledMetadata(t *testing.T) {
	for _, address := range []string{"64:ff9b::a9fe:a9fe", "64:ff9b::808:808", "2002:808:808::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "::ffff:169.254.169.254", "100::1", "2001:2::1", "2001:3::1", "3fff::1", "fec0::1", "5f00::1", "192.31.196.1", "192.52.193.1", "100.64.0.1"} {
		if permittedProbeAddress(address, false) || permittedProbeAddress(address, true) {
			t.Fatalf("%s must be blocked", address)
		}
	}
	for _, address := range []string{"8.8.8.8", "2606:4700::1111"} {
		if !permittedProbeAddress(address, false) {
			t.Fatalf("%s must be allowed", address)
		}
	}
	if permittedProbeAddress("10.0.0.1", false) || !permittedProbeAddress("10.0.0.1", true) || !permittedProbeAddress("fd12::1", true) {
		t.Fatal("private ranges must require allowPrivate")
	}
}

func TestHasIMAPCapabilityRequiresUntaggedCapabilityLine(t *testing.T) {
	if !hasIMAPCapability([]string{"* CAPABILITY IMAP4rev1 STARTTLS"}, "STARTTLS") {
		t.Fatal("untagged capability line must match")
	}
	if hasIMAPCapability([]string{"* OK STARTTLS", "* CAPABILITY IMAP4rev1"}, "STARTTLS") {
		t.Fatal("STARTTLS on another line must not match")
	}
}

func TestHasProtocolCapabilityStripsReplyPrefix(t *testing.T) {
	if !hasProtocolCapability([]string{"250-mail", "250-STARTTLS", "250 8BITMIME"}, "STARTTLS") {
		t.Fatal("STARTTLS in a multi-line EHLO reply must be detected")
	}
}

func startProbeDNSFixture(t *testing.T, records map[string][]string, rcode int, hang bool) int {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	go func() {
		buffer := make([]byte, 1500)
		for {
			n, remote, err := conn.ReadFrom(buffer)
			if err != nil {
				return
			}
			if hang {
				continue
			}
			_, _ = conn.WriteTo(probeDNSResponse(buffer[:n], records, rcode), remote)
		}
	}()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

func probeDNSName(name string) []byte {
	var out []byte
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		out = append(out, byte(len(label)))
		out = append(out, label...)
	}
	return append(out, 0)
}

func probeDNSRecordData(recordType, value string) []byte {
	switch recordType {
	case "A":
		return net.ParseIP(value).To4()
	case "AAAA":
		return net.ParseIP(value).To16()
	case "TXT":
		return append([]byte{byte(len(value))}, value...)
	case "MX":
		var preference int
		var host string
		_, _ = fmt.Sscanf(value, "%d %s", &preference, &host)
		return append([]byte{byte(preference >> 8), byte(preference)}, probeDNSName(host)...)
	}
	return probeDNSName(value)
}

func probeDNSResponse(query []byte, records map[string][]string, rcode int) []byte {
	end := 12
	for query[end] != 0 {
		end += int(query[end]) + 1
	}
	question := query[12 : end+5]
	qtype := int(question[len(question)-4])<<8 | int(question[len(question)-3])
	names := map[int]string{1: "A", 2: "NS", 5: "CNAME", 15: "MX", 16: "TXT", 28: "AAAA"}
	recordType := names[qtype]
	var answers []byte
	count := 0
	for _, value := range records[recordType] {
		data := probeDNSRecordData(recordType, value)
		answers = append(answers, 0xc0, 0x0c, byte(qtype>>8), byte(qtype), 0, 1, 0, 0, 0, 60, byte(len(data)>>8), byte(len(data)))
		answers = append(answers, data...)
		count++
	}
	response := []byte{query[0], query[1], 0x81, byte(0x80 | rcode), 0, 1, byte(count >> 8), byte(count), 0, 0, 0, 0}
	response = append(response, question...)
	return append(response, answers...)
}

func TestProbeRejectsOutOfRangeOptions(t *testing.T) {
	port := 8080
	for name, raw := range map[string]string{
		"method":       `{"http":{"method":"TRACE"}}`,
		"redirects":    `{"http":{"maxRedirects":9}}`,
		"status":       `{"http":{"expectedStatuses":[99]}}`,
		"body on get":  `{"http":{"body":"x"}}`,
		"json pointer": `{"http":{"assertions":[{"kind":"json","operator":"exists","pointer":"/a~2"}]}}`,
		"dns type":     `{"dns":{"recordType":"SRV"}}`,
	} {
		checkType := "http"
		if name == "dns type" {
			checkType = "dns"
		}
		_, err := decodeProbeOptions(probeCheck{CheckType: checkType, Port: &port, Options: json.RawMessage(raw)})
		if err == nil {
			t.Errorf("%s: expected options to be rejected", name)
		}
	}
}
