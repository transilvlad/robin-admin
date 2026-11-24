package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type securityItem struct {
	ID    string `json:"id"`
	Value any    `json:"value"`
}

type securitySection struct {
	Status   string         `json:"status"`
	Complete bool           `json:"complete"`
	Items    []securityItem `json:"items"`
	RootHash string         `json:"rootHash,omitempty"`
}

func securitySectionResult(items []securityItem, err error) securitySection {
	status := "ok"
	if errors.Is(err, fs.ErrPermission) {
		status = "not_permitted"
	} else if err != nil {
		status = "not_available"
	}
	if items == nil {
		items = []securityItem{}
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return securitySection{Status: status, Complete: err == nil, Items: items}
}

type securityConfig struct {
	enabled   bool
	interval  time.Duration
	roots     []string
	fileCap   int
	byteCap   int64
	auditKeys map[string]bool
}

func securityEnvInt(name string, fallback, minimum, maximum int) int {
	n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || n < minimum || n > maximum {
		return fallback
	}
	return n
}

func loadSecurityConfig() securityConfig {
	enabled := os.Getenv("ROBIN_AGENT_HOST_SECURITY")
	roots := []string{"/etc/ssh", "/etc/sudoers.d", "/etc/passwd", "/etc/group", "/etc/systemd/system"}
	for _, path := range strings.Split(os.Getenv("ROBIN_AGENT_HOST_SECURITY_PATHS"), ",") {
		path = strings.TrimSpace(path)
		if filepath.IsAbs(path) {
			roots = append(roots, filepath.Clean(path))
		}
	}
	keys := map[string]bool{}
	for _, key := range strings.Split(os.Getenv("ROBIN_AGENT_HOST_SECURITY_AUDIT_KEYS"), ",") {
		if key = strings.TrimSpace(key); key != "" {
			keys[key] = true
		}
	}
	return securityConfig{
		enabled:  runtime.GOOS == "linux" && (enabled == "1" || enabled == "true"),
		interval: time.Duration(securityEnvInt("ROBIN_AGENT_HOST_SECURITY_INTERVAL", 300, 60, 86400)) * time.Second,
		roots:    roots, fileCap: securityEnvInt("ROBIN_AGENT_HOST_SECURITY_FILE_CAP", 10000, 1, 20000),
		byteCap:   int64(securityEnvInt("ROBIN_AGENT_HOST_SECURITY_BYTE_CAP", 32<<20, 1024, 128<<20)),
		auditKeys: keys,
	}
}

func securityText(raw string) string {
	const capBytes = 512
	raw = strings.TrimSpace(strings.Map(func(char rune) rune {
		if char < 32 || char == 127 {
			return ' '
		}
		return char
	}, strings.ToValidUTF8(raw, "")))
	raw = securityKeyMaterial.ReplaceAllString(raw, "$1 [REDACTED]")
	if strings.Contains(raw, "PRIVATE KEY-----") {
		return "[REDACTED]"
	}
	masked, _ := maskLogEntry(raw, raw, securityLogMasks)
	if len(masked) > capBytes {
		masked = strings.ToValidUTF8(masked[:capBytes], "")
	}
	return masked
}

func readSecurityFile(path string, maxBytes int64) ([]byte, error) {
	file, err := openCheckedSecurityFile(path, maxBytes)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if int64(len(raw)) > maxBytes {
		return nil, fmt.Errorf("file exceeds collection limits")
	}
	return raw, err
}

func openCheckedSecurityFile(path string, maxBytes int64) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxBytes {
		return nil, fmt.Errorf("file excluded by collection limits")
	}
	file, err := openSecurityFile(path)
	if err != nil {
		return nil, err
	}
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		file.Close()
		return nil, fmt.Errorf("file changed before collection")
	}
	return file, nil
}

func securityCommand(ctx context.Context, timeout time.Duration, argv ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	raw, err := captureProcessWithEnv(ctx, argv, true, append(os.Environ(), "LC_ALL=C"))
	if err != nil {
		if strings.Contains(strings.ToLower(string(raw)), "permission denied") || strings.Contains(strings.ToLower(string(raw)), "must be root") {
			return "", fs.ErrPermission
		}
		return "", err
	}
	return string(raw), nil
}

func securityHash(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func securityIntegrityHash(ctx context.Context, path string, budget int64, buffer []byte) (string, int64, error) {
	name := filepath.Base(path)
	if name == "shadow" || name == "gshadow" || (strings.HasPrefix(name, "ssh_host_") && strings.HasSuffix(name, "_key")) {
		return "", 0, nil
	}
	file, err := openCheckedSecurityFile(path, budget)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	reader := io.LimitReader(file, budget+1)
	digest := sha256.New()
	const marker = "PRIVATE KEY-----"
	var total int64
	var carry int
	for {
		if err := ctx.Err(); err != nil {
			return "", total, err
		}
		count, err := reader.Read(buffer[carry:])
		total += int64(count)
		if total > budget {
			return "", budget, errors.New("integrity file grew beyond the read budget")
		}
		end := carry + count
		if bytes.Contains(buffer[:end], []byte(marker)) {
			return "", total, nil
		}
		digest.Write(buffer[carry:end])
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", total, err
		}
		carry = min(end, len(marker)-1)
		copy(buffer[:carry], buffer[end-carry:end])
	}
	return hex.EncodeToString(digest.Sum(nil)), total, nil
}

func securityManifestRoot(items []securityItem) string {
	digest := sha256.New()
	encoder := json.NewEncoder(digest)
	for _, item := range items {
		_ = encoder.Encode(item) // Inventory values contain only JSON scalars and objects.
	}
	return hex.EncodeToString(digest.Sum(nil))
}

func securityIntegrity(ctx context.Context, roots []string, count int, budget int64) securitySection {
	var items []securityItem
	var detail error
	visited := map[string]bool{}
	buffer := make([]byte, 32<<10)
	limited := errors.New("integrity limits reached")
	for _, root := range roots {
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, fs.ErrNotExist) && path == root {
				return nil
			}
			if err != nil {
				detail = errors.Join(detail, err)
				return nil
			}
			if !entry.Type().IsRegular() || visited[path] {
				return nil
			}
			if !securitySnapshotValueFits(path) {
				if detail == nil {
					detail = limited
				}
				return nil
			}
			if len(items) >= count || budget <= 0 {
				return limited
			}
			visited[path] = true
			digest, read, err := securityIntegrityHash(ctx, path, budget, buffer)
			budget -= read
			if err != nil {
				detail = errors.Join(detail, err)
				return nil
			}
			if digest == "" {
				return nil
			}
			items = append(items, securityItem{path, map[string]string{"path": path, "sha256": digest}})
			return nil
		})
		detail = errors.Join(detail, err)
		if err != nil {
			break
		}
	}
	section := securitySectionResult(items, detail)
	section.RootHash = securityManifestRoot(section.Items)
	return section
}

type securityAccount struct{ user, uid, gid, home, shell string }

func securityAccounts(text string) ([]securityAccount, []securityItem) {
	var all []securityAccount
	var interactive []securityItem
	for _, line := range strings.Split(text, "\n") {
		p := strings.Split(line, ":")
		if len(p) != 7 {
			continue
		}
		uid, err := strconv.Atoi(p[2])
		if err != nil || uid < 0 {
			continue
		}
		all = append(all, securityAccount{p[0], p[2], p[3], p[5], p[6]})
		shell := filepath.Base(p[6])
		if p[6] == "" || shell == "false" || shell == "nologin" || shell == "sync" {
			continue
		}
		interactive = append(interactive, securityItem{p[0], map[string]any{"user": p[0], "uid": uid, "home": p[5], "shell": p[6]}})
	}
	return all, interactive
}

func securityGroups(raw string, accounts []securityAccount) []securityItem {
	var items []securityItem
	for _, line := range strings.Split(raw, "\n") {
		p := strings.Split(line, ":")
		if len(p) != 4 || (p[0] != "sudo" && p[0] != "wheel" && p[0] != "admin") {
			continue
		}
		memberSet := map[string]bool{}
		if p[3] != "" {
			for _, name := range strings.Split(p[3], ",") {
				memberSet[name] = true
			}
		}
		for _, account := range accounts {
			if account.gid == p[2] {
				memberSet[account.user] = true
			}
		}
		members := make([]string, 0, len(memberSet))
		for name := range memberSet {
			members = append(members, name)
		}
		sort.Strings(members)
		items = append(items, securityItem{p[0], map[string]any{"group": p[0], "members": members}})
	}
	return items
}

func securitySSHD(raw string) ([]securityItem, []string) {
	allow := map[string]bool{"port": true, "permitrootlogin": true, "passwordauthentication": true, "kbdinteractiveauthentication": true, "pubkeyauthentication": true, "allowusers": true, "allowgroups": true, "authorizedkeysfile": true, "maxauthtries": true}
	settings := map[string][]string{}
	for _, line := range strings.Split(raw, "\n") {
		name, value, ok := strings.Cut(strings.TrimSpace(line), " ")
		if ok && allow[name] {
			settings[name] = append(settings[name], strings.TrimSpace(value))
		}
	}
	var items []securityItem
	for name, values := range settings {
		sort.Strings(values)
		items = append(items, securityItem{name, map[string]string{"name": name, "value": strings.Join(values, " ")}})
	}
	return items, strings.Fields(strings.Join(settings["authorizedkeysfile"], " "))
}

func sshKeyFields(line string) []string {
	var fields []string
	start := -1
	quoted, escaped := false, false
	for i, ch := range line {
		if start < 0 && (ch == ' ' || ch == '\t') {
			continue
		}
		if start < 0 {
			start = i
		}
		if escaped {
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			continue
		}
		if ch == '"' {
			quoted = !quoted
			continue
		}
		if !quoted && (ch == ' ' || ch == '\t') {
			fields = append(fields, line[start:i])
			start = -1
		}
	}
	if start >= 0 {
		fields = append(fields, line[start:])
	}
	return fields
}

func securityKeyOptions(raw string) []string {
	options := []string{}
	start := 0
	quoted, escaped := false, false
	appendOption := func(option string) {
		switch {
		case option == "restrict":
			options = append(options, option)
		case strings.HasPrefix(option, "command="):
			options = append(options, "command=[redacted]")
		case strings.HasPrefix(option, "from="):
			value := strings.TrimPrefix(option, "from=")
			if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
				value = value[1 : len(value)-1]
			}
			options = append(options, "from="+securityText(value))
		}
	}
	for index, char := range raw {
		if escaped {
			escaped = false
			continue
		}
		switch char {
		case '\\':
			escaped = true
		case '"':
			quoted = !quoted
		case ',':
			if !quoted {
				appendOption(raw[start:index])
				start = index + 1
			}
		}
	}
	if !quoted {
		appendOption(raw[start:])
	}
	sort.Strings(options)
	return options
}

func sshWirePart(blob []byte) ([]byte, []byte) {
	if len(blob) < 4 {
		return nil, nil
	}
	size := uint64(binary.BigEndian.Uint32(blob))
	if size > uint64(len(blob)-4) {
		return nil, nil
	}
	return blob[4 : 4+size], blob[4+size:]
}

func parseSecurityKey(line, user, file string) (securityItem, bool) {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return securityItem{}, false
	}
	fields := sshKeyFields(line)
	for i := 0; i < len(fields) && i < 2 && i+1 < len(fields); i++ {
		keyType := fields[i]
		if !strings.HasPrefix(keyType, "ssh-") && !strings.HasPrefix(keyType, "ecdsa-") && !strings.HasPrefix(keyType, "sk-") {
			continue
		}
		blob, err := base64.StdEncoding.DecodeString(fields[i+1])
		if err != nil {
			continue
		}
		kind, rest := sshWirePart(blob)
		if string(kind) != keyType {
			continue
		}
		var bits any
		switch keyType {
		case "ssh-ed25519", "sk-ssh-ed25519@openssh.com":
			bits = 256
		case "ssh-rsa":
			_, rest = sshWirePart(rest)
			modulus, _ := sshWirePart(rest)
			for len(modulus) > 0 && modulus[0] == 0 {
				modulus = modulus[1:]
			}
			if len(modulus) > 0 {
				n := (len(modulus) - 1) * 8
				for b := modulus[0]; b > 0; b >>= 1 {
					n++
				}
				bits = n
			}
		default:
			if strings.Contains(keyType, "nistp256") {
				bits = 256
			} else if strings.Contains(keyType, "nistp384") {
				bits = 384
			} else if strings.Contains(keyType, "nistp521") {
				bits = 521
			}
		}
		digest := sha256.Sum256(blob)
		fingerprint := "SHA256:" + base64.RawStdEncoding.EncodeToString(digest[:])
		options := []string{}
		if i == 1 {
			options = securityKeyOptions(fields[0])
		}
		comment := securityText(strings.ReplaceAll(strings.Join(fields[i+2:], " "), fields[i+1], "[REDACTED]"))
		return securityItem{user + "|" + file + "|" + fingerprint, map[string]any{"user": user, "file": file, "fingerprint": fingerprint, "type": keyType, "bits": bits, "comment": comment, "options": options}}, true
	}
	return securityItem{}, false
}

func securityKeys(ctx context.Context, accounts []securityAccount, patterns []string, initial error) securitySection {
	items := []securityItem{}
	detail := initial
	budget := int64(8 << 20)
	const keyLimit = 5000
	for _, account := range accounts {
		if ctx.Err() != nil {
			detail = errors.Join(detail, ctx.Err())
			break
		}
		if !filepath.IsAbs(account.home) {
			continue
		}
		paths := append([]string{".ssh/authorized_keys"}, patterns...)
		seen := map[string]bool{}
		for _, path := range paths {
			if path == "none" {
				continue
			}
			path = strings.NewReplacer("%%", "%", "%h", account.home, "%u", account.user, "%U", account.uid).Replace(path)
			if !filepath.IsAbs(path) {
				path = filepath.Join(account.home, path)
			}
			path = filepath.Clean(path)
			if seen[path] {
				continue
			}
			seen[path] = true
			if budget <= 0 || len(items) >= keyLimit {
				return securitySectionResult(items, errors.Join(detail, errors.New("authorized key inventory limit reached")))
			}
			raw, err := readSecurityFile(path, min(budget, 1<<20))
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				detail = errors.Join(detail, err)
				continue
			}
			budget -= int64(len(raw))
			duplicates := map[string]int{}
			for _, line := range strings.Split(string(raw), "\n") {
				if item, ok := parseSecurityKey(line, account.user, path); ok {
					if len(items) >= keyLimit {
						return securitySectionResult(items, errors.Join(detail, errors.New("authorized key inventory limit reached")))
					}
					duplicates[item.ID]++
					if duplicates[item.ID] > 1 {
						item.ID += "|" + strconv.Itoa(duplicates[item.ID])
					}
					items = append(items, item)
				}
			}
		}
	}
	return securitySectionResult(items, detail)
}

func securityConfigFiles(ctx context.Context, roots []string, cron bool) securitySection {
	var items []securityItem
	var detail error
	for _, root := range roots {
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, fs.ErrNotExist) && path == root {
				return nil
			}
			if err != nil {
				detail = errors.Join(detail, err)
				return nil
			}
			if entry.IsDir() && path != root {
				return fs.SkipDir
			}
			if !entry.Type().IsRegular() {
				return nil
			}
			raw, err := readSecurityFile(path, 1<<20)
			if err != nil {
				detail = errors.Join(detail, err)
				return nil
			}
			if cron {
				scanner := bufio.NewScanner(strings.NewReader(string(raw)))
				count := 0
				for scanner.Scan() {
					count++
				}
				if scanner.Err() != nil {
					detail = errors.Join(detail, scanner.Err())
					return nil
				}
				items = append(items, securityItem{path, map[string]any{"file": path, "sha256": securityHash(raw), "lines": count}})
			} else {
				seen := map[string]bool{}
				for _, line := range strings.Split(string(raw), "\n") {
					line = strings.TrimSpace(line)
					if line == "" || strings.HasPrefix(line, "#") {
						continue
					}
					// Avoid including command arguments, environment settings or comments.
					rule, _, _ := strings.Cut(line, "=")
					if !strings.Contains(line, "=") {
						continue
					}
					nopasswd := strings.Contains(line, "NOPASSWD:")
					id := path + "|" + securityHash([]byte(line))
					if seen[id] {
						continue
					}
					seen[id] = true
					items = append(items, securityItem{id, map[string]any{"file": path, "rule": securityText(rule), "nopasswd": nopasswd}})
				}
			}
			return nil
		})
		detail = errors.Join(detail, err)
	}
	return securitySectionResult(items, detail)
}

func securityUnits(raw string) []securityItem {
	var items []securityItem
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.HasPrefix(fields[1], "enabled") {
			continue
		}
		items = append(items, securityItem{fields[0], map[string]string{"unit": fields[0], "state": fields[1]}})
	}
	return items
}

// processParent returns a process's parent PID from /proc.
var processParent = func(pid int) (int, bool) {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, false
	}
	// The command name may contain spaces or parentheses; the state and
	// parent PID follow its closing parenthesis.
	i := bytes.LastIndexByte(stat, ')')
	if i < 0 {
		return 0, false
	}
	f := strings.Fields(string(stat[i+1:]))
	if len(f) < 2 {
		return 0, false
	}
	parent, err := strconv.Atoi(f[1])
	return parent, err == nil
}

// listenerOwner names the process that owns a listening socket: the listed
// process whose parent is not also listed. Workers that inherit the socket,
// such as Postfix smtpd under master, come and go, so taking the first listed
// process made the name flap. PIDs wrap, so their order cannot decide it.
func listenerOwner(line string) string {
	_, users, ok := strings.Cut(line, "users:((")
	if !ok {
		return ""
	}
	type user struct {
		name string
		pid  int
	}
	var listed []user
	pids := map[int]bool{}
	for _, entry := range strings.Split(users, "),(") {
		rest, ok := strings.CutPrefix(entry, "\"")
		if !ok {
			continue
		}
		name, rest, ok := strings.Cut(rest, "\"")
		if !ok {
			continue
		}
		pid := 0
		if _, after, ok := strings.Cut(rest, "pid="); ok {
			digits, _, _ := strings.Cut(after, ",")
			pid, _ = strconv.Atoi(digits)
		}
		listed = append(listed, user{name, pid})
		if pid > 0 {
			pids[pid] = true
		}
	}
	if len(listed) == 0 {
		return ""
	}
	for _, u := range listed {
		if u.pid <= 0 {
			continue
		}
		if parent, ok := processParent(u.pid); ok && !pids[parent] {
			return u.name
		}
	}
	return listed[0].name
}

func securityListeners(raw string) []securityItem {
	items := map[string]securityItem{}
	for _, line := range strings.Split(raw, "\n") {
		f := strings.Fields(line)
		if len(f) < 6 || (f[0] != "tcp" && f[0] != "udp") {
			continue
		}
		address, port, err := net.SplitHostPort(f[4])
		if err != nil {
			continue
		}
		ip := net.ParseIP(strings.SplitN(address, "%", 2)[0])
		if ip != nil && ip.IsLoopback() {
			continue
		}
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			continue
		}
		var process any
		if name := listenerOwner(line); name != "" {
			process = securityText(name)
		}
		key := f[0] + "|" + address + "|" + port
		if existing, exists := items[key]; exists && existing.Value.(map[string]any)["process"] != nil {
			continue
		}
		items[key] = securityItem{key, map[string]any{"protocol": f[0], "address": address, "port": n, "process": process}}
	}
	result := make([]securityItem, 0, len(items))
	for _, item := range items {
		result = append(result, item)
	}
	return result
}

func securityFirewall(ctx context.Context) securitySection {
	var detail error
	for _, backend := range []string{"nftables", "iptables", "ufw"} {
		var output string
		var err error
		var policy string
		switch backend {
		case "nftables":
			output, err = securityCommand(ctx, time.Second, "nft", "-j", "list", "ruleset")
			if err == nil {
				var rules struct {
					NFTables []struct {
						Chain struct {
							Hook   string
							Family string
							Policy string
						}
					}
				}
				if json.Unmarshal([]byte(output), &rules) == nil {
					coverage := map[string]bool{}
					for _, entry := range rules.NFTables {
						chain := entry.Chain
						if chain.Hook != "input" || (chain.Family != "ip" && chain.Family != "ip6" && chain.Family != "inet") {
							continue
						}
						if policy != "" && policy != chain.Policy {
							policy = "unknown"
							break
						}
						policy = chain.Policy
						coverage[chain.Family] = true
					}
					if policy != "" && !coverage["inet"] && !(coverage["ip"] && coverage["ip6"]) {
						policy = "unknown"
					}
				}
			}
		case "iptables":
			v4, err4 := securityCommand(ctx, time.Second, "iptables", "-S", "INPUT")
			v6, err6 := securityCommand(ctx, time.Second, "ip6tables", "-S", "INPUT")
			err = errors.Join(err4, err6)
			for _, candidate := range []string{"drop", "accept"} {
				prefix := "-P INPUT " + strings.ToUpper(candidate)
				if strings.Contains(v4, prefix) && strings.Contains(v6, prefix) && err == nil {
					policy = candidate
				} else if policy == "" && (strings.Contains(v4, prefix) || strings.Contains(v6, prefix)) {
					policy = "unknown"
				}
			}
		case "ufw":
			output, err = securityCommand(ctx, time.Second, "ufw", "status", "verbose")
			if strings.Contains(output, "deny (incoming)") || strings.Contains(output, "reject (incoming)") {
				policy = "drop"
			}
			if strings.Contains(output, "allow (incoming)") {
				policy = "accept"
			}
		}
		detail = errors.Join(detail, err)
		if policy == "accept" || policy == "drop" {
			return securitySectionResult([]securityItem{{"default", map[string]string{"backend": backend, "inbound": policy}}}, nil)
		}
		if policy == "unknown" {
			return securitySectionResult([]securityItem{{"default", map[string]string{"backend": backend, "inbound": policy}}},
				errors.Join(err, errors.New("firewall policies differ or are unavailable for one address family")))
		}
	}
	if detail == nil {
		detail = errors.New("inbound policy unavailable")
	}
	return securitySectionResult([]securityItem{{"default", map[string]string{"backend": "unknown", "inbound": "unknown"}}}, detail)
}

func securityPatching(ctx context.Context) securitySection {
	kernel, _ := securityCommand(ctx, time.Second, "uname", "-r")
	osRelease, _ := readSecurityFile("/usr/lib/os-release", 1<<16)
	for _, line := range strings.Split(string(osRelease), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			osRelease = []byte(strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\""))
			break
		}
	}
	var rebootSince any
	var rebootRequired any = false
	if info, err := os.Stat("/run/reboot-required"); err == nil {
		rebootRequired = true
		rebootSince = info.ModTime().UTC().Format(time.RFC3339)
	} else if !errors.Is(err, fs.ErrNotExist) {
		rebootRequired = nil
	}
	pending, security := 0, 0
	output, err := securityCommand(ctx, 6*time.Second, "apt-get", "-s", "-o", "Debug::NoLocking=true", "upgrade")
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(line, "Inst ") {
			pending++
			_, origin, _ := strings.Cut(line, "(")
			for _, field := range strings.Fields(origin) {
				suite := strings.ToLower(strings.Trim(field, "[],)"))
				if strings.HasSuffix(suite, "-security") || strings.Contains(suite, "-security:") {
					security++
					break
				}
			}
		}
	}
	var pendingValue, securityValue any
	if err == nil {
		pendingValue, securityValue = pending, security
	}
	return securitySectionResult([]securityItem{{"system", map[string]any{"pending": pendingValue, "security": securityValue, "rebootRequired": rebootRequired, "rebootSince": rebootSince, "kernel": securityText(kernel), "os": securityText(string(osRelease))}}}, err)
}

func collectSecuritySnapshot(ctx context.Context, cfg securityConfig) map[string]securitySection {
	result := make(map[string]securitySection)
	passwd, err := readSecurityFile("/etc/passwd", 1<<20)
	accounts, interactive := securityAccounts(string(passwd))
	result["accounts"] = securitySectionResult(interactive, err)
	group, groupErr := readSecurityFile("/etc/group", 1<<20)
	result["privilegedGroups"] = securitySectionResult(securityGroups(string(group), accounts), errors.Join(groupErr, err))
	sshd, sshdErr := securityCommand(ctx, 2*time.Second, "sshd", "-T")
	settings, paths := securitySSHD(sshd)
	result["sshd"] = securitySectionResult(settings, sshdErr)
	result["sshKeys"] = securityKeys(ctx, accounts, paths, errors.Join(err, sshdErr))
	result["sudoers"] = securityConfigFiles(ctx, []string{"/etc/sudoers", "/etc/sudoers.d"}, false)
	result["cron"] = securityConfigFiles(ctx, []string{"/etc/crontab", "/etc/cron.d", "/var/spool/cron", "/var/spool/cron/crontabs"}, true)
	units, unitsErr := securityCommand(ctx, 2*time.Second, "systemctl", "list-unit-files", "--state=enabled,enabled-runtime", "--no-pager", "--no-legend")
	result["systemd"] = securitySectionResult(securityUnits(units), unitsErr)
	listeners, listenersErr := securityCommand(ctx, 2*time.Second, "ss", "-H", "-lntup")
	result["listeners"] = securitySectionResult(securityListeners(listeners), listenersErr)
	result["firewall"] = securityFirewall(ctx)
	result["patching"] = securityPatching(ctx)
	result["integrity"] = securityIntegrity(ctx, cfg.roots, cfg.fileCap, cfg.byteCap)
	return fitSecuritySnapshot(result)
}

// Bound the serialized heartbeat below the server's request limit. Removing
// unreadable or oversized records leaves their section explicitly incomplete.
func fitSecuritySnapshot(sections map[string]securitySection) map[string]securitySection {
	keys := []string{"sshKeys", "sshd", "accounts", "privilegedGroups", "sudoers", "cron", "systemd", "listeners", "firewall", "patching", "integrity"}
	remaining := 3 << 20
	for _, name := range keys {
		section := sections[name]
		limit, sectionBudget := 5000, min(remaining, 192<<10)
		if name == "integrity" {
			limit, sectionBudget = 20000, remaining
		}
		accepted := section.Items[:0]
		for _, item := range section.Items {
			if len(item.ID) > 1024 || len(accepted) >= limit || !securitySnapshotValueFits(item.Value) ||
				strings.IndexFunc(item.ID, func(r rune) bool { return r < 32 || r == 127 }) >= 0 {
				section.Complete = false
				continue
			}
			encoded, err := json.Marshal(item)
			if err != nil || len(encoded)+1 > sectionBudget {
				section.Complete = false
				continue
			}
			sectionBudget -= len(encoded) + 1
			remaining -= len(encoded) + 1
			accepted = append(accepted, item)
		}
		section.Items = accepted
		if section.RootHash != "" {
			section.RootHash = securityManifestRoot(accepted)
		}
		sections[name] = section
	}
	return sections
}

func securitySnapshotValueFits(value any) bool {
	switch input := value.(type) {
	case string:
		return len(input) <= 512 && utf8.ValidString(input) &&
			strings.IndexFunc(input, func(r rune) bool { return r < 32 || r == 127 }) < 0
	case []string:
		for _, item := range input {
			if !securitySnapshotValueFits(item) {
				return false
			}
		}
		return len(input) <= 1000
	case map[string]string:
		for _, item := range input {
			if !securitySnapshotValueFits(item) {
				return false
			}
		}
	case map[string]any:
		for name, item := range input {
			if !securitySnapshotValueFits(item) {
				return false
			}
			if name == "options" {
				if options, ok := item.([]string); !ok || len(options) > 16 {
					return false
				}
			}
		}
	}
	return true
}
