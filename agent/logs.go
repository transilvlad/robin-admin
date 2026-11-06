package main

// ── Log shipping ─────────────────────────────────────────────────────────────
// The agent follows a service's log file, newest dated file, container console
// or journald unit and ships new lines to robin-admin, which keeps a rolling
// buffer for the service page, stores the lines for Logs search and derives
// Postfix message counters from them. File and directory sources are read
// natively (no tail/grep/sh needed) so a minimal log-mount sidecar can serve
// logs for several services at once.
//
// Each batch is saved with an id and the read position after it before it is
// sent, and is resent with the same id until robin-admin acknowledges it.
// Read positions survive restarts: only a service without a saved position
// (first start, or a changed log source) ships its recent tail with reset=true,
// which refreshes the rolling buffer and is neither stored nor counted.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	logTailLines        = 200
	logTailMaxBytes     = 1 << 20  // the recent tail reads at most the last 1 MiB of a file
	logBatchMaxLines    = 5000     // lines per pushed batch
	logBatchMaxBytes    = 1 << 20  // bytes read per pushed batch
	logBatchesPerCycle  = 16       // batches pushed per service per sync cycle while catching up
	logLineMaxBytes     = 64 << 10 // longer streamed lines are cut; robin-admin cuts stored lines shorter
	logFingerprintBytes = 4096     // leading bytes that identify a followed file across restarts
	logCollectTimeout   = 15 * time.Second
)

type logSource struct {
	unit      string
	file      string
	dir       string
	glob      string
	container string // a container whose console output is the log (`docker logs`)
	filter    string
}

var errNoDatedLogFiles = errors.New("no matching log files")

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

// datedLogFiles orders matching uncompressed files from oldest to newest.
func datedLogFiles(dir, glob string) ([]string, error) {
	matches, err := filepath.Glob(filepath.Join(dir, glob))
	if err != nil {
		return nil, err
	}
	type candidate struct {
		path string
		mod  time.Time
	}
	files := make([]candidate, 0, len(matches))
	for _, m := range matches {
		switch strings.ToLower(filepath.Ext(m)) {
		case ".gz", ".zip", ".xz", ".zst", ".bz2":
			continue
		}
		fi, err := os.Stat(m)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				return nil, err
			}
			continue
		}
		if fi.Mode().IsRegular() {
			files = append(files, candidate{path: m, mod: fi.ModTime()})
		}
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("%w: %s", errNoDatedLogFiles, filepath.Join(dir, glob))
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].mod.Equal(files[j].mod) {
			return files[i].path < files[j].path
		}
		return files[i].mod.Before(files[j].mod)
	})
	paths := make([]string, len(files))
	for i := range files {
		paths[i] = files[i].path
	}
	return paths, nil
}

// numberedLogFiles orders uncompressed rotations (name.N) before the active
// file. A missing active file is normal during rotation.
func numberedLogFiles(active string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Dir(active))
	if err != nil {
		return nil, err
	}
	type rotation struct {
		path   string
		number int
	}
	prefix := filepath.Base(active) + "."
	var rotations []rotation
	activeExists := false
	for _, entry := range entries {
		if entry.Name() == filepath.Base(active) {
			activeExists = true
			continue
		}
		suffix, ok := strings.CutPrefix(entry.Name(), prefix)
		if !ok {
			continue
		}
		number, err := strconv.Atoi(suffix)
		if err == nil && number > 0 && strconv.Itoa(number) == suffix {
			rotations = append(rotations, rotation{path: filepath.Join(filepath.Dir(active), entry.Name()), number: number})
		}
	}
	sort.Slice(rotations, func(i, j int) bool { return rotations[i].number > rotations[j].number })
	paths := make([]string, 0, len(rotations)+1)
	for _, rotation := range rotations {
		paths = append(paths, rotation.path)
	}
	if activeExists {
		paths = append(paths, active)
	}
	return paths, nil
}

type logFileCandidate struct {
	path string
	info os.FileInfo
}

func snapshotLogCandidates(list func() ([]string, error)) ([]logFileCandidate, error) {
	paths, err := list()
	if err != nil {
		return nil, err
	}
	candidates := make([]logFileCandidate, 0, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			return nil, fmt.Errorf("snapshot log file %s: %w", path, err)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("log file %s is not a regular file", path)
		}
		candidates = append(candidates, logFileCandidate{path: path, info: info})
	}
	current, err := list()
	if err != nil {
		return nil, err
	}
	if !slices.Equal(paths, current) {
		return nil, errors.New("log files changed during discovery; retrying")
	}
	return candidates, nil
}

func openLogCandidate(candidate logFileCandidate) (*os.File, error) {
	f, err := os.Open(candidate.path)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if !os.SameFile(candidate.info, info) {
		_ = f.Close()
		return nil, fmt.Errorf("log file %s changed during discovery; retrying", candidate.path)
	}
	return f, nil
}

// logCursor is the read position after the last acknowledged batch. Key
// identifies the configured source; a different key starts over with a reset.
type logCursor struct {
	Key             string    `json:"key"`
	Source          string    `json:"source"`
	Path            string    `json:"path,omitempty"`            // file sources: the file being read
	Offset          int64     `json:"offset,omitempty"`          // file sources: bytes already shipped
	Fingerprint     string    `json:"fingerprint,omitempty"`     // file sources: SHA-256 of the leading bytes
	FingerprintSize int64     `json:"fingerprintSize,omitempty"` // file sources: how many leading bytes
	Device          uint64    `json:"device,omitempty"`          // file sources: filesystem identity
	Inode           uint64    `json:"inode,omitempty"`
	Journal         string    `json:"journal,omitempty"`      // journald cursor
	Since           time.Time `json:"since,omitzero"`         // container and journald: newest time read
	DockerSeen      int       `json:"dockerSeen,omitempty"`   // lines already read at Since
	DockerCursor    int       `json:"dockerCursor,omitempty"` // 1 uses inclusive timestamps and DockerSeen
}

// logBatch is a batch waiting for robin-admin's acknowledgement, with the
// position to continue from once it is acknowledged.
type logBatch struct {
	ID     string    `json:"id,omitempty"`
	Source string    `json:"source"`
	Lines  []string  `json:"lines"`
	Times  []string  `json:"times"`
	Reset  bool      `json:"reset"`
	Next   logCursor `json:"next"`
}

type logServiceState struct {
	Cursor       *logCursor  `json:"cursor,omitempty"`
	Pending      *logBatch   `json:"pending,omitempty"`
	PendingQueue []*logBatch `json:"pendingQueue,omitempty"`
}

// logStateStore keeps each service's position and pending batch in a file
// next to the agent state. Only the sync loop touches it.
type logStateStore struct {
	path     string
	loaded   bool
	services map[string]*logServiceState
}

var logStates = &logStateStore{}

func logStatePath(statePath string) string {
	if statePath == "" {
		return ""
	}
	return statePath + ".log-cursors.json"
}

func (s *logStateStore) service(statePath, serviceID string) (*logServiceState, error) {
	if err := s.load(logStatePath(statePath)); err != nil {
		return nil, err
	}
	st := s.services[serviceID]
	if st == nil {
		st = &logServiceState{}
		s.services[serviceID] = st
	}
	return st, nil
}

func (s *logStateStore) load(path string) error {
	if s.loaded && s.path == path {
		return nil
	}
	s.path, s.loaded, s.services = path, false, map[string]*logServiceState{}
	if path == "" {
		s.loaded = true
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			s.loaded = true
			return nil
		}
		return fmt.Errorf("read log positions from %s: %w", path, err)
	}
	if err := json.Unmarshal(data, &s.services); err != nil {
		return fmt.Errorf("decode log positions from %s: %w", path, err)
	}
	if s.services == nil {
		return fmt.Errorf("decode log positions from %s: expected a service map", path)
	}
	for id, st := range s.services {
		if id == "" || st == nil {
			return fmt.Errorf("decode log positions from %s: invalid service entry", path)
		}
		if st.Cursor != nil && !validLogCursor(st.Cursor) {
			return fmt.Errorf("decode log positions from %s: invalid cursor for %s", path, id)
		}
		if st.Pending != nil && (st.Pending.ID == "" || !validLogCursor(&st.Pending.Next)) {
			return fmt.Errorf("decode log positions from %s: invalid pending batch for %s", path, id)
		}
		for _, batch := range st.PendingQueue {
			if batch == nil || batch.ID == "" || !validLogCursor(&batch.Next) {
				return fmt.Errorf("decode log positions from %s: invalid pending batch queue for %s", path, id)
			}
		}
		if st.Pending == nil && len(st.PendingQueue) > 0 {
			return fmt.Errorf("decode log positions from %s: pending batch queue has no head for %s", path, id)
		}
	}
	s.loaded = true
	return nil
}

func validLogCursor(cur *logCursor) bool {
	if cur.Key == "" || cur.Offset < 0 || cur.FingerprintSize < 0 ||
		cur.FingerprintSize > logFingerprintBytes || cur.DockerSeen < 0 ||
		(cur.DockerCursor != 0 && cur.DockerCursor != 1) {
		return false
	}
	if cur.FingerprintSize > 0 {
		fingerprint, err := hex.DecodeString(cur.Fingerprint)
		return err == nil && len(fingerprint) == sha256.Size
	}
	return true
}

func (s *logStateStore) save() error {
	if s.path == "" {
		return nil
	}
	data, err := json.Marshal(s.services)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(s.path, data); err != nil {
		return fmt.Errorf("persist log positions to %s: %w", s.path, err)
	}
	return nil
}

// retain forgets services this agent no longer ships logs for.
func (s *logStateStore) retain(statePath string, keep map[string]bool) error {
	if err := s.load(logStatePath(statePath)); err != nil {
		return err
	}
	removed := map[string]*logServiceState{}
	for id := range s.services {
		if !keep[id] {
			removed[id] = s.services[id]
			delete(s.services, id)
		}
	}
	if len(removed) == 0 {
		return nil
	}
	if err := s.save(); err != nil {
		for id, state := range removed {
			s.services[id] = state
		}
		return err
	}
	return nil
}

// writeFileAtomic syncs the temporary file before renaming it over the target.
func writeFileAtomic(file string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	handle, err := os.CreateTemp(filepath.Dir(file), "."+filepath.Base(file)+"-*")
	if err != nil {
		return err
	}
	temporary := handle.Name()
	defer os.Remove(temporary)
	if err := handle.Chmod(0600); err != nil {
		_ = handle.Close()
		return err
	}
	if _, err := handle.Write(data); err != nil {
		_ = handle.Close()
		return err
	}
	if err := handle.Sync(); err != nil {
		_ = handle.Close()
		return err
	}
	if err := handle.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, file)
}

func newLogBatchID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// pushServiceLogs ships the service's new log lines, resending a batch that
// was not acknowledged before reading further. Quiet cycles still push an
// empty batch, which tells robin-admin the log source is live.
func pushServiceLogs(ctx context.Context, client *http.Client, c config, s state, svc ownedService) {
	st, err := logStates.service(c.statePath, svc.ServiceID)
	if err != nil {
		log.Printf("robin-agent: warning: %v", err)
		return
	}
	for range logBatchesPerCycle {
		more := st.Pending != nil || len(st.PendingQueue) > 0
		if st.Pending == nil {
			batch, hasMore, err := collectLogs(ctx, svc, st.Cursor)
			if err != nil {
				log.Printf("robin-agent: warning: could not collect logs for %s: %v", svc.ServiceID, err)
				return
			}
			if batch == nil {
				return
			}
			more = hasMore
			if len(batch.Lines) == 0 && !batch.Reset {
				code, err := sendLogBatch(ctx, client, c, s, svc, batch)
				switch {
				case err != nil:
					log.Printf("robin-agent: warning: could not send log heartbeat for %s: %v", svc.ServiceID, err)
				case code < 200 || code >= 300:
					log.Printf("robin-agent: warning: robin-admin refused a log heartbeat for %s (HTTP %d)", svc.ServiceID, code)
				default:
					if st.Cursor == nil || *st.Cursor != batch.Next {
						previous := st.Cursor
						st.Cursor = &batch.Next
						if err := logStates.save(); err != nil {
							st.Cursor = previous
							log.Printf("robin-agent: warning: %v", err)
						}
					}
				}
				return
			}
			batch.ID, err = newLogBatchID()
			if err != nil {
				log.Printf("robin-agent: warning: could not create a log batch id for %s: %v", svc.ServiceID, err)
				return
			}
			st.Pending = batch
			if err := logStates.save(); err != nil {
				st.Pending = nil
				log.Printf("robin-agent: warning: %v", err)
				return
			}
		}
		batch := st.Pending
		code, err := sendLogBatch(ctx, client, c, s, svc, batch)
		switch {
		case err == nil && code >= 200 && code < 300:
			if len(batch.Lines) > 0 {
				log.Printf("robin-agent: pushed %d log line(s) for %s (%s)", len(batch.Lines), svc.ServiceID, svc.ServiceType)
			}
		case err == nil && code == http.StatusRequestEntityTooLarge && len(batch.Lines) > 1:
			first, remainder := splitLogBatch(batch)
			first.ID, err = newLogBatchID()
			if err == nil {
				remainder.ID, err = newLogBatchID()
			}
			if err != nil {
				log.Printf("robin-agent: warning: could not split oversized log batch for %s: %v", svc.ServiceID, err)
				return
			}
			previous := st.Pending
			previousQueue := st.PendingQueue
			st.Pending = first
			st.PendingQueue = append([]*logBatch{remainder}, previousQueue...)
			if err := logStates.save(); err != nil {
				st.Pending, st.PendingQueue = previous, previousQueue
				log.Printf("robin-agent: warning: could not persist split log batch for %s: %v", svc.ServiceID, err)
				return
			}
			continue
		default:
			if err != nil {
				log.Printf("robin-agent: warning: could not send log batch for %s: %v", svc.ServiceID, err)
			} else {
				log.Printf("robin-agent: warning: robin-admin refused a log batch for %s (HTTP %d); keeping it for retry", svc.ServiceID, code)
			}
			return // keep the batch and resend it next cycle
		}
		previousCursor, previousPending, previousQueue := st.Cursor, st.Pending, st.PendingQueue
		if len(st.PendingQueue) > 0 {
			st.Pending = st.PendingQueue[0]
			st.PendingQueue = append([]*logBatch(nil), st.PendingQueue[1:]...)
		} else {
			next := batch.Next
			st.Cursor, st.Pending = &next, nil
		}
		if err := logStates.save(); err != nil {
			st.Cursor, st.Pending, st.PendingQueue = previousCursor, previousPending, previousQueue
			log.Printf("robin-agent: warning: %v", err)
			return
		}
		if !more {
			return
		}
	}
}

func splitLogBatch(batch *logBatch) (*logBatch, *logBatch) {
	middle := len(batch.Lines) / 2
	first, remainder := *batch, *batch
	first.Lines = append([]string(nil), batch.Lines[:middle]...)
	remainder.Lines = append([]string(nil), batch.Lines[middle:]...)
	if len(batch.Times) >= middle {
		first.Times = append([]string(nil), batch.Times[:middle]...)
		remainder.Times = append([]string(nil), batch.Times[middle:]...)
	}
	return &first, &remainder
}

func sendLogBatch(ctx context.Context, client *http.Client, c config, s state, svc ownedService, batch *logBatch) (int, error) {
	lines, times := batch.Lines, batch.Times
	if lines == nil {
		lines = []string{} // a quiet cycle must encode as [], not null
	}
	if times == nil {
		times = []string{}
	}
	body := map[string]any{"source": batch.Source, "lines": lines, "times": times, "reset": batch.Reset}
	if batch.ID != "" {
		body["batchId"] = batch.ID
	}
	headers := map[string]string{"Authorization": "Bearer " + s.Credential, "X-Robin-Agent-Id": s.AgentID}
	logsURL := c.adminURL + "/api/fleet/agent/services/" + url.PathEscape(svc.ServiceID) + "/logs"
	return postJSONContext(ctx, client, logsURL, headers, body, nil)
}

// collectLogs reads the batch after cur, or the recent tail with reset=true
// when cur is nil or belongs to a different source. It reports whether more
// lines are already waiting. A nil batch without an error means the service
// has no log source on this host.
func collectLogs(parent context.Context, svc ownedService, cur *logCursor) (*logBatch, bool, error) {
	ctx, cancel := context.WithTimeout(parent, logCollectTimeout)
	defer cancel()
	src, known := resolveLogSource(svc.ServiceType, svc.ServiceID)
	if !known {
		return nil, false, nil
	}
	forKey := func(key string) *logCursor {
		if cur != nil && cur.Key == key {
			return cur
		}
		return nil
	}
	if src.container == "" && src.file != "" {
		key := "file:" + src.file + "|" + src.filter
		// A followed file that is briefly missing (mid-rotation) is waited for
		// rather than switching to another source.
		if _, err := os.Stat(src.file); err == nil || forKey(key) != nil {
			return followFile(key, src.file, src.filter, forKey(key))
		} else if !errors.Is(err, fs.ErrNotExist) {
			return nil, false, err
		}
	}
	if src.container == "" && src.dir != "" && src.glob != "" {
		key := "dir:" + filepath.Join(src.dir, src.glob) + "|" + src.filter
		if candidates, err := snapshotLogCandidates(func() ([]string, error) {
			return datedLogFiles(src.dir, src.glob)
		}); err == nil {
			return followFileCandidates(key, candidates[len(candidates)-1].path, src.filter, forKey(key), candidates, openLogCandidate)
		} else if forKey(key) != nil || !errors.Is(err, errNoDatedLogFiles) {
			return nil, false, err
		}
	}
	if src.container != "" {
		key := "docker:" + src.container + "|" + src.filter
		return followContainer(ctx, key, src.container, src.filter, forKey(key))
	}
	if src.unit != "" {
		if _, err := exec.LookPath("journalctl"); err != nil {
			return nil, false, nil
		}
		key := "journald:" + src.unit + "|" + src.filter
		return followJournal(ctx, key, src.unit, src.filter, forKey(key))
	}
	return nil, false, nil
}

// ── Files ────────────────────────────────────────────────────────────────────

// followFile continues through the remaining numbered rotations in order.
func followFile(key, active, filter string, cur *logCursor) (*logBatch, bool, error) {
	candidates, err := snapshotLogCandidates(func() ([]string, error) { return numberedLogFiles(active) })
	if err != nil {
		return nil, false, err
	}
	return followFileCandidates(key, active, filter, cur, candidates, openLogCandidate)
}

func followFileCandidates(key, active, filter string, cur *logCursor, candidates []logFileCandidate, openCandidate func(logFileCandidate) (*os.File, error)) (*logBatch, bool, error) {
	if cur == nil {
		var activeCandidate *logFileCandidate
		for i := range candidates {
			if candidates[i].path == active {
				activeCandidate = &candidates[i]
				break
			}
		}
		if activeCandidate == nil {
			return nil, false, fmt.Errorf("no readable log file for %s", active)
		}
		f, err := openCandidate(*activeCandidate)
		if err != nil {
			return nil, false, err
		}
		defer f.Close()
		lines, end, err := tailFile(f, logTailLines, filter)
		if err != nil {
			return nil, false, err
		}
		next := logCursor{Key: key, Source: active, Path: active, Offset: end}
		if err := setFileIdentity(&next, f); err != nil {
			return nil, false, err
		}
		return &logBatch{Source: active, Lines: lines, Times: lineTimes(lines, time.Now()), Reset: true, Next: next}, false, nil
	}
	if len(candidates) == 0 {
		return nil, false, fmt.Errorf("no readable log file for %s", active)
	}
	match := func(ignoreIdentity bool) (*os.File, int, error) {
		var found *os.File
		foundIndex := -1
		for i, candidate := range candidates {
			path := candidate.path
			if cur.FingerprintSize == 0 && cur.Inode == 0 && path != cur.Path {
				continue
			}
			f, err := openCandidate(candidate)
			if err != nil {
				if found != nil {
					_ = found.Close()
				}
				return nil, -1, err
			}
			same, err := sameLogFile(f, cur, ignoreIdentity)
			if err != nil {
				_ = f.Close()
				if found != nil {
					_ = found.Close()
				}
				return nil, -1, err
			}
			if same {
				device, inode := logFileIdentity(candidate.info)
				if !ignoreIdentity && cur.Inode != 0 && inode == cur.Inode && device == cur.Device {
					if found != nil {
						_ = found.Close()
					}
					return f, i, nil
				}
				if found != nil {
					_ = found.Close()
					_ = f.Close()
					return nil, -1, nil
				}
				found, foundIndex = f, i
			} else {
				_ = f.Close()
			}
		}
		return found, foundIndex, nil
	}
	f, index, err := match(false)
	if err != nil {
		return nil, false, err
	}
	if f == nil && cur.FingerprintSize > 0 && cur.Inode != 0 {
		f, index, err = match(true)
		if err != nil {
			return nil, false, err
		}
	}
	next := *cur
	if f == nil {
		// Once the followed file has been deleted, compressed, or truncated,
		// its unread bytes cannot be reconstructed.
		log.Printf("robin-agent: warning: followed log %s is no longer identifiable; unread lines may be lost and available files may be replayed", cur.Path)
		index = 0
		f, err = openCandidate(candidates[index])
		if err != nil {
			return nil, false, err
		}
		next = logCursor{Key: key}
	}
	defer f.Close()
	next.Path, next.Source = candidates[index].path, candidates[index].path
	source := next.Source
	before, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	raw, offset, more, err := readFileChunkFromFile(f, next.Offset)
	if err != nil {
		return nil, false, err
	}
	next.Offset = offset
	if err := setFileIdentity(&next, f); err != nil {
		return nil, false, err
	}
	if !more && index+1 < len(candidates) {
		after, err := f.Stat()
		if err != nil {
			return nil, false, err
		}
		if after.Size() > before.Size() {
			more = true
		} else {
			if after.Size() > next.Offset {
				log.Printf("robin-agent: warning: incomplete trailing log line in %s was skipped during rotation", source)
			}
			candidate := candidates[index+1]
			nextFile, err := openCandidate(candidate)
			if err != nil {
				return nil, false, err
			}
			next = logCursor{Key: key, Source: candidate.path, Path: candidate.path}
			err = setFileIdentity(&next, nextFile)
			_ = nextFile.Close()
			if err != nil {
				return nil, false, err
			}
			more = true
		}
	}
	lines, times := filterLines(raw, lineTimes(raw, time.Now()), filter)
	return &logBatch{Source: source, Lines: lines, Times: times, Next: next}, more, nil
}

func sameLogFile(f *os.File, cur *logCursor, ignoreIdentity bool) (bool, error) {
	info, err := f.Stat()
	if err != nil {
		return false, err
	}
	device, inode := logFileIdentity(info)
	if !ignoreIdentity && cur.Inode != 0 && inode != 0 && (cur.Device != device || cur.Inode != inode) {
		return false, nil
	}
	if info.Size() < cur.Offset {
		return false, nil
	}
	if !info.Mode().IsRegular() {
		return false, nil
	}
	if cur.FingerprintSize == 0 {
		return true, nil
	}
	fp, size, err := fileFingerprint(f, cur.FingerprintSize)
	if err != nil {
		return false, err
	}
	return size == cur.FingerprintSize && fp == cur.Fingerprint, nil
}

func setFileIdentity(cur *logCursor, f *os.File) error {
	info, err := f.Stat()
	if err != nil {
		return err
	}
	cur.Device, cur.Inode = logFileIdentity(info)
	if cur.FingerprintSize < logFingerprintBytes {
		fp, size, err := fileFingerprint(f, logFingerprintBytes)
		if err != nil {
			return err
		}
		if size >= cur.FingerprintSize {
			cur.Fingerprint, cur.FingerprintSize = fp, size
		}
	}
	return nil
}

func fileFingerprint(f *os.File, n int64) (string, int64, error) {
	hash := sha256.New()
	size, err := io.Copy(hash, io.NewSectionReader(f, 0, n))
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}

// tailFile returns the last n matching lines within the final logTailMaxBytes
// of a file and the offset just past the last complete line. If the read
// started mid-line, the leading partial line is dropped.
func tailFile(f *os.File, n int, filter string) ([]string, int64, error) {
	fi, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	start := max(0, fi.Size()-logTailMaxBytes)
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, 0, err
	}
	data, err := io.ReadAll(io.LimitReader(f, fi.Size()-start))
	if err != nil {
		return nil, 0, err
	}
	end := bytes.LastIndexByte(data, '\n')
	if end < 0 {
		return nil, start, nil
	}
	lines := splitLines(data[:end])
	if start > 0 && len(lines) > 0 {
		lines = lines[1:]
	}
	lines, _ = filterLines(lines, nil, filter)
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines, start + int64(end) + 1, nil
}

// readFileChunk returns complete lines and the position after them without
// advancing over unread backlog. A long line is truncated but consumed whole.
func readFileChunk(path string, offset int64) (lines []string, next int64, more bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, offset, false, err
	}
	defer f.Close()
	return readFileChunkFromFile(f, offset)
}

func readFileChunkFromFile(f *os.File, offset int64) (lines []string, next int64, more bool, err error) {
	fi, err := f.Stat()
	if err != nil {
		return nil, offset, false, err
	}
	size := fi.Size()
	if size < offset {
		offset = 0
	}
	want := min(size-offset, logBatchMaxBytes)
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, offset, false, err
	}
	data := make([]byte, want)
	if _, err := io.ReadFull(f, data); err != nil {
		return nil, offset, false, err
	}
	end := bytes.LastIndexByte(data, '\n')
	switch {
	case end >= 0:
		data = data[:end+1]
	case want == logBatchMaxBytes:
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return nil, offset, false, err
		}
		reader := bufio.NewReaderSize(f, logLineMaxBytes)
		var line []byte
		var consumed int64
		for {
			part, readErr := reader.ReadSlice('\n')
			consumed += int64(len(part))
			if room := logLineMaxBytes - len(line); room > 0 {
				line = append(line, part[:min(len(part), room)]...)
			}
			if errors.Is(readErr, bufio.ErrBufferFull) {
				continue
			}
			if errors.Is(readErr, io.EOF) {
				return nil, offset, false, nil
			}
			if readErr != nil {
				return nil, offset, false, readErr
			}
			next = offset + consumed
			return []string{string(bytes.TrimRight(line, "\r\n"))}, next, next < size, nil
		}
	default:
		return nil, offset, false, nil // no complete line yet
	}
	limited := false
	for i, count := 0, 0; i < len(data); i++ {
		if data[i] == '\n' {
			count++
			if count == logBatchMaxLines {
				data, limited = data[:i+1], true
				break
			}
		}
	}
	lines = splitLines(bytes.TrimSuffix(data, []byte("\n")))
	for i, line := range lines {
		if len(line) > logLineMaxBytes {
			lines[i] = line[:logLineMaxBytes]
		}
	}
	next = offset + int64(len(data))
	return lines, next, next < size && (limited || want == logBatchMaxBytes), nil
}

func splitLines(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSuffix(line, "\r")
	}
	return lines
}

// filterLines keeps the lines containing filter, with their times.
func filterLines(lines, times []string, filter string) ([]string, []string) {
	if filter == "" {
		return lines, times
	}
	keptLines := make([]string, 0, len(lines))
	var keptTimes []string
	if times != nil {
		keptTimes = make([]string, 0, len(lines))
	}
	for i, line := range lines {
		if strings.Contains(line, filter) {
			keptLines = append(keptLines, line)
			if times != nil {
				keptTimes = append(keptTimes, times[i])
			}
		}
	}
	return keptLines, keptTimes
}

// ── Line times ───────────────────────────────────────────────────────────────

var (
	isoLineTime    = regexp.MustCompile(`^\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,9}))?(Z|[+-]\d{2}:?\d{2}| UTC| GMT)?`)
	syslogLineTime = regexp.MustCompile(`^([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}:\d{2}:\d{2})`)
	ctimeLineTime  = regexp.MustCompile(`^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})`)
)

// parseLineTime reads the timestamp a log line starts with: ISO 8601 (with or
// without a zone, `T` or space separated), ctime (`Wed Nov  4 10:00:00 2026`)
// or BSD syslog (`Nov  4 10:00:00`, whose year is the current one unless that
// would be more than a day ahead). Times without a zone are local.
func parseLineTime(line string, now time.Time) (time.Time, bool) {
	if m := isoLineTime.FindStringSubmatch(line); m != nil {
		value := m[1] + "T" + m[2]
		if m[3] != "" {
			value += "." + m[3]
		}
		switch zone := m[4]; {
		case zone == "":
			t, err := time.ParseInLocation("2006-01-02T15:04:05.999999999", value, time.Local)
			return t, err == nil
		case zone == "Z" || zone == " UTC" || zone == " GMT":
			t, err := time.ParseInLocation("2006-01-02T15:04:05.999999999", value, time.UTC)
			return t, err == nil
		default:
			if len(zone) == 5 {
				zone = zone[:3] + ":" + zone[3:]
			}
			t, err := time.Parse(time.RFC3339Nano, value+zone)
			return t, err == nil
		}
	}
	if m := ctimeLineTime.FindStringSubmatch(line); m != nil {
		t, err := time.ParseInLocation("Jan 2 15:04:05 2006", m[1]+" "+m[2]+" "+m[3]+" "+m[4], time.Local)
		return t, err == nil
	}
	if m := syslogLineTime.FindStringSubmatch(line); m != nil {
		t, err := time.ParseInLocation("Jan 2 15:04:05 2006", m[1]+" "+m[2]+" "+m[3]+" "+strconv.Itoa(now.Year()), time.Local)
		if err != nil {
			return time.Time{}, false
		}
		if t.After(now.Add(24 * time.Hour)) {
			t = t.AddDate(-1, 0, 0)
		}
		return t, true
	}
	return time.Time{}, false
}

// lineTimes returns each line's time as RFC 3339. A line without its own
// timestamp (a continuation such as a stack trace) takes the previous line's;
// lines before the first timestamp are left empty for robin-admin to date.
func lineTimes(lines []string, now time.Time) []string {
	times := make([]string, len(lines))
	previous := ""
	for i, line := range lines {
		if t, ok := parseLineTime(line, now); ok {
			previous = t.Format(time.RFC3339Nano)
		}
		times[i] = previous
	}
	return times
}

// ── Streamed sources ─────────────────────────────────────────────────────────

// streamLines runs argv and passes each output line to visit until visit
// returns false or the output ends. Stopping early ends the process and is not
// an error. Lines longer than logLineMaxBytes are cut.
func streamLines(parent context.Context, argv []string, combined bool, visit func(line []byte) bool) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	defer reader.Close()
	var stderr commandOutput
	process := exec.CommandContext(ctx, argv[0], argv[1:]...)
	process.WaitDelay = commandWaitDelay
	process.Stdout, process.Stderr = writer, &stderr
	if combined {
		process.Stderr = writer
	}
	if err := process.Start(); err != nil {
		_ = writer.Close()
		return err
	}
	_ = writer.Close()
	// A descendant still holding the pipe must not block the read past the deadline.
	stopReading := context.AfterFunc(ctx, func() { _ = reader.Close() })
	defer stopReading()

	buffered := bufio.NewReaderSize(reader, 64<<10)
	stopped := false
	for {
		line, readErr := readBoundedLine(buffered, logLineMaxBytes)
		if len(line) > 0 || readErr == nil {
			if !visit(line) {
				stopped = true
				break
			}
		}
		if readErr != nil {
			break
		}
	}
	if stopped {
		cancel()
	}
	waitErr := process.Wait()
	switch {
	case stopped:
		return nil
	case parent.Err() != nil:
		return parent.Err()
	default:
		return waitErr
	}
}

func readBoundedLine(r *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	for {
		chunk, err := r.ReadSlice('\n')
		if room := limit - len(line); room > 0 {
			line = append(line, chunk[:min(len(chunk), room)]...)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return bytes.TrimRight(line, "\r\n"), err
	}
}

// containerRead streams a container's stdout/stderr log (services that log to
// the console rather than a file) with docker's inclusive timestamps. The
// ordinal distinguishes multiple lines with the same timestamp.
func containerRead(ctx context.Context, container string, since time.Time, seen int, legacy bool, limited bool, extra ...string) (lines []string, times []time.Time, lastCount int, more bool, err error) {
	argv := append(append([]string{"docker", "logs", "--timestamps"}, extra...), container)
	read, skipped := 0, 0
	err = streamLines(ctx, argv, true, func(raw []byte) bool {
		stamp, text, ok := strings.Cut(string(raw), " ")
		ts, perr := time.Parse(time.RFC3339Nano, stamp)
		if !ok || perr != nil || ts.Before(since) {
			return true
		}
		if ts.Equal(since) && (legacy || skipped < seen) {
			skipped++
			return true
		}
		if len(times) > 0 && ts.Equal(times[len(times)-1]) {
			lastCount++
		} else {
			lastCount = 1
			if ts.Equal(since) {
				lastCount += seen
			}
		}
		lines, times = append(lines, text), append(times, ts)
		read += len(raw) + 1
		if limited && (len(lines) >= logBatchMaxLines || read >= logBatchMaxBytes) {
			more = true
			return false
		}
		return true
	})
	if err != nil {
		return nil, nil, 0, false, fmt.Errorf("docker logs %s: %w", container, err)
	}
	return lines, times, lastCount, more, nil
}

func followContainer(ctx context.Context, key, container, filter string, cur *logCursor) (*logBatch, bool, error) {
	source := "docker logs " + container
	if cur == nil {
		started := time.Now()
		lines, times, _, _, err := containerRead(ctx, container, time.Time{}, 0, false, false, "--tail", strconv.Itoa(logTailLines*10))
		if err != nil {
			return nil, false, err
		}
		next := logCursor{Key: key, Source: source, Since: started, DockerCursor: 1}
		kept, keptTimes := filterLines(lines, formatTimes(times), filter)
		if len(kept) > logTailLines {
			kept, keptTimes = kept[len(kept)-logTailLines:], keptTimes[len(keptTimes)-logTailLines:]
		}
		return &logBatch{Source: source, Lines: kept, Times: keptTimes, Reset: true, Next: next}, false, nil
	}
	lines, times, lastCount, more, err := containerRead(ctx, container, cur.Since, cur.DockerSeen, cur.DockerCursor == 0, true, "--since", cur.Since.Format(time.RFC3339Nano))
	if err != nil {
		return nil, false, err
	}
	next := *cur
	if len(times) > 0 {
		next.Since = times[len(times)-1]
		next.DockerSeen = lastCount
		next.DockerCursor = 1
	}
	kept, keptTimes := filterLines(lines, formatTimes(times), filter)
	return &logBatch{Source: source, Lines: kept, Times: keptTimes, Next: next}, more, nil
}

func formatTimes(times []time.Time) []string {
	out := make([]string, len(times))
	for i, t := range times {
		out[i] = t.Format(time.RFC3339Nano)
	}
	return out
}

// journalEntry holds the journald export fields a line is rebuilt from. Each
// may be a string, a byte array (non-UTF-8 data) or a list of either.
type journalEntry struct {
	Cursor     string          `json:"__CURSOR"`
	Realtime   string          `json:"__REALTIME_TIMESTAMP"`
	Hostname   json.RawMessage `json:"_HOSTNAME"`
	Identifier json.RawMessage `json:"SYSLOG_IDENTIFIER"`
	Command    json.RawMessage `json:"_COMM"`
	PID        json.RawMessage `json:"_PID"`
	Message    json.RawMessage `json:"MESSAGE"`
}

func journalField(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var data []byte
	var numbers []int
	if json.Unmarshal(raw, &numbers) == nil {
		data = make([]byte, len(numbers))
		for i, n := range numbers {
			data[i] = byte(n)
		}
		return string(data)
	}
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) == nil && len(list) > 0 {
		return journalField(list[0])
	}
	return ""
}

// journalLine renders an entry like journalctl's short-iso output.
func journalLine(entry journalEntry) (string, time.Time, bool) {
	micros, err := strconv.ParseInt(entry.Realtime, 10, 64)
	if err != nil || entry.Cursor == "" {
		return "", time.Time{}, false
	}
	t := time.UnixMicro(micros)
	ident := journalField(entry.Identifier)
	if ident == "" {
		ident = journalField(entry.Command)
	}
	if pid := journalField(entry.PID); pid != "" {
		ident += "[" + pid + "]"
	}
	line := t.Format("2006-01-02T15:04:05-0700") + " " + journalField(entry.Hostname) + " " + ident + ": " + journalField(entry.Message)
	return line, t, true
}

// journaldRead streams a unit's journal entries after a cursor (or since a
// time, or its last n entries), returning the rendered lines, their times, the
// last entry's cursor and whether a batch limit cut the read short.
func journaldRead(ctx context.Context, unit, filter string, limited bool, position ...string) (lines []string, times []time.Time, cursor string, more bool, err error) {
	argv := append([]string{"journalctl", "-u", unit, "--no-pager", "-o", "json"}, position...)
	if filter != "" {
		argv = append(argv, "--grep", filter)
	}
	read := 0
	err = streamLines(ctx, argv, false, func(raw []byte) bool {
		var entry journalEntry
		if json.Unmarshal(raw, &entry) != nil {
			return true
		}
		line, t, ok := journalLine(entry)
		if !ok {
			return true
		}
		lines, times, cursor = append(lines, line), append(times, t), entry.Cursor
		read += len(line) + 1
		if limited && (len(lines) >= logBatchMaxLines || read >= logBatchMaxBytes) {
			more = true
			return false
		}
		return true
	})
	if err != nil {
		return nil, nil, "", false, fmt.Errorf("journalctl -u %s: %w", unit, err)
	}
	return lines, times, cursor, more, nil
}

func followJournal(ctx context.Context, key, unit, filter string, cur *logCursor) (*logBatch, bool, error) {
	source := "journalctl -u " + unit
	if cur == nil {
		lines, times, cursor, _, err := journaldRead(ctx, unit, filter, false, "-n", strconv.Itoa(logTailLines))
		if err != nil {
			return nil, false, err
		}
		next := logCursor{Key: key, Source: source, Journal: cursor, Since: time.Now()}
		return &logBatch{Source: source, Lines: lines, Times: formatTimes(times), Reset: true, Next: next}, false, nil
	}
	position := []string{"--after-cursor", cur.Journal}
	if cur.Journal == "" {
		position = []string{"--since", "@" + strconv.FormatInt(cur.Since.Unix(), 10)}
	}
	lines, times, cursor, more, err := journaldRead(ctx, unit, filter, true, position...)
	if err != nil {
		return nil, false, err
	}
	next := *cur
	if cursor != "" {
		next.Journal = cursor
	}
	return &logBatch{Source: source, Lines: lines, Times: formatTimes(times), Next: next}, more, nil
}
