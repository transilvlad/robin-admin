package main

// ── Command channel ─────────────────────────────────────────────────────────
// robin-admin queues typed actions; the agent long-polls for them over its
// outbound connection, runs the fixed command each action maps to, and posts
// the raw output back. robin-admin never sends argv: every action below is an
// allowlisted command with validated arguments, so the channel cannot be turned
// into arbitrary execution on the host.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type agentCommand struct {
	ID          string         `json:"id"`
	ServiceID   string         `json:"serviceId"`
	ServiceType string         `json:"serviceType"`
	Action      string         `json:"action"`
	Args        map[string]any `json:"args"`
}

const (
	commandTimeout   = 15 * time.Second
	commandWaitDelay = time.Second
	commandMaxOutput = 4 << 20
	maxQueueIDs      = 500
)

// Keep operational diagnostics separate from authenticated command output.
type commandEvent struct {
	Event      string `json:"event"`
	CommandID  string `json:"commandId"`
	ServiceID  string `json:"serviceId,omitempty"`
	Action     string `json:"action,omitempty"`
	ElapsedMs  int64  `json:"elapsedMs"`
	Attempt    int    `json:"attempt,omitempty"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	Outcome    string `json:"outcome,omitempty"`
}

func logCommandEvent(event string, cmd agentCommand, started time.Time, attempt, status int, outcome string) {
	encoded, _ := json.Marshal(commandEvent{event, cmd.ID, cmd.ServiceID, cmd.Action, time.Since(started).Milliseconds(), attempt, status, outcome})
	log.Printf("robin-agent: command lifecycle %s", encoded)
}

var (
	queueIDPattern = regexp.MustCompile(`^[0-9A-Za-z]{5,32}$`)
	// Mailbox users are passed as argv — and through `ssh` exec prefixes, a
	// remote shell — so only plain address characters are accepted.
	userPattern = regexp.MustCompile(`^[A-Za-z0-9._@+=][A-Za-z0-9._@+=-]{0,255}$`)
)

// commandSpec builds the command(s) for an action. Each returned argv runs in
// order; the output of the last one is shipped.
type commandSpec struct {
	serviceType string
	build       func(args map[string]any) ([][]string, error)
}

func fixed(argv ...string) func(map[string]any) ([][]string, error) {
	return func(map[string]any) ([][]string, error) { return [][]string{argv}, nil }
}

func queueIDsArg(args map[string]any) ([]string, error) {
	raw, _ := args["queueIds"].([]any)
	if len(raw) == 0 || len(raw) > maxQueueIDs {
		return nil, fmt.Errorf("queueIds must list 1-%d queue IDs", maxQueueIDs)
	}
	ids := make([]string, 0, len(raw))
	for _, v := range raw {
		id, _ := v.(string)
		if !queueIDPattern.MatchString(id) {
			return nil, fmt.Errorf("invalid queue ID %q", id)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func queueIDArg(args map[string]any) (string, error) {
	id, _ := args["queueId"].(string)
	if !queueIDPattern.MatchString(id) {
		return "", fmt.Errorf("invalid queue ID %q", id)
	}
	return id, nil
}

func userArg(args map[string]any) (string, error) {
	user, _ := args["user"].(string)
	if !userPattern.MatchString(user) {
		return "", fmt.Errorf("invalid user %q", user)
	}
	return user, nil
}

// postsuper takes one flag per queue ID (`postsuper -d A -d B`).
func postsuper(flag string) func(map[string]any) ([][]string, error) {
	return func(args map[string]any) ([][]string, error) {
		ids, err := queueIDsArg(args)
		if err != nil {
			return nil, err
		}
		argv := []string{"postsuper"}
		for _, id := range ids {
			argv = append(argv, flag, id)
		}
		return [][]string{argv}, nil
	}
}

var commandSpecs = map[string]commandSpec{
	"postfix.queue.list": {"postfix", fixed("postqueue", "-j")},
	"postfix.queue.show": {"postfix", func(args map[string]any) ([][]string, error) {
		id, err := queueIDArg(args)
		if err != nil {
			return nil, err
		}
		return [][]string{{"postcat", "-ehbq", id}}, nil
	}},
	"postfix.queue.hold":    {"postfix", postsuper("-h")},
	"postfix.queue.release": {"postfix", postsuper("-H")},
	"postfix.queue.requeue": {"postfix", postsuper("-r")},
	"postfix.queue.delete":  {"postfix", postsuper("-d")},
	"postfix.queue.deliver": {"postfix", func(args map[string]any) ([][]string, error) {
		id, err := queueIDArg(args)
		if err != nil {
			return nil, err
		}
		return [][]string{{"postqueue", "-i", id}}, nil
	}},
	"postfix.queue.flush": {"postfix", fixed("postqueue", "-f")},
	// Validate first so a bad managed override can never take the MTA down.
	"postfix.reload": {"postfix", func(map[string]any) ([][]string, error) {
		return [][]string{{"postfix", "check"}, {"postfix", "reload"}}, nil
	}},
	"rspamd.reload": {"rspamd", func(map[string]any) ([][]string, error) {
		return [][]string{{"rspamadm", "configtest"}, {"rspamadm", "control", "reload"}}, nil
	}},
	"dovecot.reload": {"dovecot", func(map[string]any) ([][]string, error) {
		return [][]string{{"doveconf", "-n"}, {"doveadm", "reload"}}, nil
	}},
	"dovecot.who": {"dovecot", fixed("doveadm", "who", "-1")},
	"dovecot.kick": {"dovecot", func(args map[string]any) ([][]string, error) {
		user, err := userArg(args)
		if err != nil {
			return nil, err
		}
		return [][]string{{"doveadm", "kick", user}}, nil
	}},
	"dovecot.quota": {"dovecot", func(args map[string]any) ([][]string, error) {
		if args["user"] == nil || args["user"] == "" {
			return [][]string{{"doveadm", "-f", "tab", "quota", "get", "-A"}}, nil
		}
		user, err := userArg(args)
		if err != nil {
			return nil, err
		}
		return [][]string{{"doveadm", "-f", "tab", "quota", "get", "-u", user}}, nil
	}},
	"dovecot.user": {"dovecot", func(args map[string]any) ([][]string, error) {
		user, err := userArg(args)
		if err != nil {
			return nil, err
		}
		return [][]string{{"doveadm", "user", user}}, nil
	}},
}

// actionSet is what this agent can do right now: the actions it advertises
// on the command poll, and the per-service reports sent with each heartbeat.
type actionSet struct {
	mu      sync.Mutex
	actions []string
	reports map[string]serviceReport
}

func (a *actionSet) set(reports map[string]serviceReport) {
	a.mu.Lock()
	a.reports = reports
	a.actions = unionActions(reports)
	a.mu.Unlock()
}

func (a *actionSet) get() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.actions
}

func (a *actionSet) serviceReports() map[string]serviceReport {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.reports
}

// Drain output without retaining unbounded data or returning partial success.
type commandOutput struct {
	buffer   bytes.Buffer
	overflow bool
}

func (b *commandOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := commandMaxOutput - b.buffer.Len()
	if n > remaining {
		b.overflow = true
		p = p[:remaining]
	}
	_, _ = b.buffer.Write(p)
	return n, nil
}

func runCommand(parent context.Context, c config, cmd agentCommand) (string, error) {
	spec, ok := commandSpecs[cmd.Action]
	if !ok || spec.serviceType != cmd.ServiceType {
		return "", fmt.Errorf("unsupported action %s for %s", cmd.Action, cmd.ServiceType)
	}
	argvs, err := spec.build(cmd.Args)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(parent, commandTimeout)
	defer cancel()
	var output []byte
	for _, argv := range argvs {
		if err := ctx.Err(); err != nil {
			return "", fmt.Errorf("command execution: %w", err)
		}
		full := c.execArgv(cmd.ServiceID, argv)
		output, err = captureProcess(ctx, full, true)
		if err != nil {
			return "", fmt.Errorf("%s: %w: %s", strings.Join(argv, " "), err, strings.TrimSpace(truncate(output, 2000)))
		}
	}
	return string(output), nil
}

func truncate(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n])
	}
	return string(b)
}

// commandRefusedRetry is how long an agent the command channel refuses waits
// before asking again. A variable so tests can shorten it.
var commandRefusedRetry = 15 * time.Minute

// pollCommands long-polls robin-admin for queued actions until ctx ends.
func pollCommands(ctx context.Context, c config, s state, actions *actionSet) {
	// The server holds a poll open for ~25s, so this client outlives it.
	client := newHTTPClient(c.insecureTLS)
	client.Timeout = 40 * time.Second
	headers := map[string]string{"Authorization": "Bearer " + s.Credential, "X-Robin-Agent-Id": s.AgentID}
	backoff := time.Second
	// ack confirms the previous poll's commands on the next one, so the server
	// re-sends anything a lost response dropped. It is kept until a poll
	// succeeds, since a failed poll's request may never have arrived.
	ack := []string{}
	seen := newSeenCommands()
	refused := false
	for ctx.Err() == nil {
		pollURL := c.adminURL + "/api/fleet/agent/commands?actions=" + url.QueryEscape(strings.Join(actions.get(), ",")) +
			"&ack=" + url.QueryEscape(strings.Join(ack, ","))
		var env apiEnvelope
		code, err := agentGet(ctx, client, pollURL, s, &env)
		if err == nil && code == http.StatusForbidden {
			// A probe-only agent may not use the command channel. That only
			// changes when the agent is re-enrolled, so ask again rarely.
			if !refused {
				log.Printf("robin-agent: command channel refused for this agent; checking again every %s", commandRefusedRetry)
				refused = true
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(commandRefusedRetry):
			}
			continue
		}
		refused = false
		if err != nil || code < 200 || code >= 300 || !env.Success {
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		backoff = time.Second
		for _, id := range ack {
			logCommandEvent("acknowledgement_confirmed", agentCommand{ID: id}, time.Now(), 0, code, "")
		}
		var cmds []agentCommand
		if err := json.Unmarshal(env.Data, &cmds); err != nil {
			ack = ack[:0]
			continue
		}
		ack = ack[:0]
		for _, cmd := range cmds {
			logCommandEvent("received", cmd, time.Now(), 0, 0, "")
			ack = append(ack, cmd.ID)
			// A re-sent command this agent already started must not run twice.
			if !seen.add(cmd.ID) {
				logCommandEvent("duplicate_skipped", cmd, time.Now(), 0, 0, "")
				continue
			}
			go func(cmd agentCommand) {
				started := time.Now()
				logCommandEvent("execution_started", cmd, started, 0, 0, "")
				output, err := runCommand(ctx, c, cmd)
				outcome := "succeeded"
				body := map[string]any{"ok": err == nil, "output": output}
				if err != nil {
					body["error"] = err.Error()
					outcome = "failed"
				}
				logCommandEvent("execution_completed", cmd, started, 0, 0, outcome)
				resultURL := c.adminURL + "/api/fleet/agent/commands/" + url.PathEscape(cmd.ID) + "/result"
				_ = reportCommandResult(ctx, client, resultURL, headers, body, cmd)
			}(cmd)
		}
	}
}

// Retry delivery only, never the already-executed command. A process crash can
// still lose this in-memory result; external side effects are not exactly-once.
func reportCommandResult(parent context.Context, client *http.Client, url string, headers map[string]string, body any, cmd agentCommand) error {
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	backoff := 250 * time.Millisecond
	started := time.Now()
	attempt := 0
	for {
		attempt++
		logCommandEvent("result_delivery_attempt", cmd, started, attempt, 0, "")
		code, err := postJSONContext(ctx, client, url, headers, body, nil)
		if err == nil && code == http.StatusOK {
			logCommandEvent("result_delivery_completed", cmd, started, attempt, code, "accepted")
			return nil
		}
		if err == nil && code >= 400 && code < 500 && code != http.StatusRequestTimeout && code != http.StatusTooManyRequests {
			logCommandEvent("result_delivery_completed", cmd, started, attempt, code, "rejected")
			return fmt.Errorf("result rejected (HTTP %d)", code)
		}
		select {
		case <-ctx.Done():
			outcome := "deadline"
			if parent.Err() != nil {
				outcome = "cancelled"
			}
			logCommandEvent("result_delivery_completed", cmd, started, attempt, code, outcome)
			return fmt.Errorf("result delivery deadline: %w", ctx.Err())
		case <-time.After(backoff):
			logCommandEvent("result_delivery_retry", cmd, started, attempt, code, "")
		}
		backoff = min(backoff*2, 2*time.Second)
	}
}

// seenCommands remembers recently received command ids so a command the
// server re-sends (its confirmation was lost) is not run a second time.
type seenCommands struct {
	ids map[string]time.Time
}

// Longer than the server's command timeout, after which it stops re-sending.
const seenCommandTTL = 5 * time.Minute

func newSeenCommands() *seenCommands {
	return &seenCommands{ids: map[string]time.Time{}}
}

// add records id and reports whether it was new.
func (s *seenCommands) add(id string) bool {
	now := time.Now()
	for known, at := range s.ids {
		if now.Sub(at) > seenCommandTTL {
			delete(s.ids, known)
		}
	}
	if _, ok := s.ids[id]; ok {
		return false
	}
	s.ids[id] = now
	return true
}
