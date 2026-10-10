package main

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// serviceReport tells robin-admin how this agent reaches one service and what
// it can do there, so the UI shows only what works in this setup.
type serviceReport struct {
	// Access is how commands reach the service: "local" (same host or
	// container), "container" (docker/podman exec), "ssh", or "other".
	Access string `json:"access"`
	// FileDelivery is whether rendered config files can be placed where the
	// service reads them; over ssh they cannot.
	FileDelivery bool `json:"fileDelivery"`
	// ApplyOnly is staging mode: files are written but nothing is reloaded.
	ApplyOnly bool     `json:"applyOnly"`
	Actions   []string `json:"actions"`
}

func accessKind(prefix string) string {
	switch {
	case strings.TrimSpace(prefix) == "":
		return "local"
	case isSSHPrefix(prefix):
		return "ssh"
	}
	if _, container := containerExecTarget(prefix); container != "" {
		return "container"
	}
	return "other"
}

// toolProbe remembers whether a tool exists where a service's commands run,
// so each sync doesn't exec into every container again.
type toolProbe struct {
	mu      sync.Mutex
	results map[string]probeResult
}

type probeResult struct {
	present bool
	at      time.Time
}

const toolProbeTTL = 5 * time.Minute

var tools = &toolProbe{results: map[string]probeResult{}}

func (p *toolProbe) present(ctx context.Context, c config, serviceID, tool string) bool {
	key := serviceID + "\x00" + tool
	p.mu.Lock()
	cached, ok := p.results[key]
	p.mu.Unlock()
	if ok && time.Since(cached.at) < toolProbeTTL {
		return cached.present
	}
	var present bool
	if action, ok := strings.CutPrefix(tool, "action:"); ok {
		present = probeAction(ctx, c, serviceID, actionProbes[action])
	} else {
		present = probeTool(ctx, c, serviceID, tool)
	}
	p.mu.Lock()
	p.results[key] = probeResult{present: present, at: time.Now()}
	p.mu.Unlock()
	return present
}

// probeTool looks for a tool where the service's commands run: on this host,
// or through its exec prefix inside the container or on the remote host.
func probeTool(parent context.Context, c config, serviceID, tool string) bool {
	prefix := c.execPrefix[serviceID]
	if prefix == "" {
		_, err := exec.LookPath(tool)
		return err == nil
	}
	if _, err := exec.LookPath(strings.Fields(prefix)[0]); err != nil {
		return false
	}
	argv := c.execArgv(serviceID, []string{"sh", "-c", "command -v " + tool})
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	err := exec.CommandContext(ctx, argv[0], argv[1:]...).Run()
	if err == nil {
		return true
	}
	// A minimal image without a shell can't answer (exit 126/127); assume the
	// tool is there and let the command itself report otherwise.
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && (exitErr.ExitCode() == 126 || exitErr.ExitCode() == 127) {
		return true
	}
	return false
}

// actionProbe tells whether an action works where the service runs, beyond
// its tool being installed: run a harmless command and look for the refusal.
type actionProbe struct {
	argv []string
	// unavailable is output meaning the action can't work in this setup.
	unavailable string
}

var actionProbes = map[string]actionProbe{
	// doveadm has no quota command unless the quota plugin is loaded; a lookup
	// for a user that doesn't exist tells the two apart without touching data.
	"dovecot.quota": {argv: []string{"doveadm", "quota", "get", "-u", "robin-agent-probe"}, unavailable: "Unknown command 'quota'"},
}

func probeAction(parent context.Context, c config, serviceID string, probe actionProbe) bool {
	if len(probe.argv) == 0 {
		return false
	}
	argv := c.execArgv(serviceID, probe.argv)
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	out, err := captureProcess(ctx, argv, true)
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		return false
	}
	return !strings.Contains(string(out), probe.unavailable)
}

// serviceActions lists the actions whose every tool is present for svc.
func serviceActions(c config, svc ownedService, has func(serviceID, tool string) bool) []string {
	var out []string
	if !svc.CollectMetrics && !svc.CollectConfig {
		return out
	}
	for action, spec := range commandSpecs {
		if spec.serviceType != svc.ServiceType {
			continue
		}
		argvs, err := spec.build(map[string]any{"queueIds": []any{"AAAAA"}, "queueId": "AAAAA", "user": "probe"})
		if err != nil || len(argvs) == 0 {
			continue
		}
		ok := true
		for _, argv := range argvs {
			if !has(svc.ServiceID, filepath.Base(argv[0])) {
				ok = false
				break
			}
		}
		if _, probed := actionProbes[action]; ok && probed {
			ok = has(svc.ServiceID, "action:"+action)
		}
		if ok {
			out = append(out, action)
		}
	}
	sort.Strings(out)
	return out
}

func serviceReports(c config, services []ownedService, has func(serviceID, tool string) bool) map[string]serviceReport {
	out := map[string]serviceReport{}
	for _, svc := range services {
		access := accessKind(c.execPrefix[svc.ServiceID])
		out[svc.ServiceID] = serviceReport{
			Access:       access,
			FileDelivery: access == "local" || access == "container",
			ApplyOnly:    c.applyOnly,
			Actions:      serviceActions(c, svc, has),
		}
	}
	return out
}

// unionActions is every action any owned service supports, for the command poll.
func unionActions(reports map[string]serviceReport) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range reports {
		for _, a := range r.Actions {
			if !seen[a] {
				seen[a] = true
				out = append(out, a)
			}
		}
	}
	sort.Strings(out)
	return out
}
