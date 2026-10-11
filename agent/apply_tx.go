package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// errToolMissing marks an apply step whose command is not installed here.
type errToolMissing struct{ tool string }

func (e errToolMissing) Error() string { return e.tool + " is not installed here" }

// runApplyCommand runs one postconf, validate or reload step. Tests replace it.
var runApplyCommand = func(ctx context.Context, argv []string) ([]byte, error) {
	if _, err := exec.LookPath(argv[0]); err != nil {
		return nil, errToolMissing{tool: argv[0]}
	}
	return captureProcess(ctx, argv, true)
}

// fileBackup is a managed file's state before an apply changed it.
type fileBackup struct {
	target  string // path on the agent's filesystem
	dest    string // path in the container, or "" when not copied in
	existed bool
	content []byte
	mode    os.FileMode
}

// applyTx records what an apply changes, so a failed validation or reload
// puts the previous config back instead of leaving it for the next restart.
type applyTx struct {
	cli, container string
	backups        []fileBackup
	// postconf holds main.cf values to restore: "key=value" to set again, or a
	// bare key that was unset before and is removed again.
	postconf  []string
	postconfX []string
	execArgv  func([]string) []string
}

func (tx *applyTx) backup(target, dest string) error {
	b := fileBackup{target: target, dest: dest}
	info, err := os.Stat(target)
	switch {
	case err == nil:
		data, err := os.ReadFile(target)
		if err != nil {
			return err
		}
		b.existed, b.content, b.mode = true, data, info.Mode().Perm()
	case !os.IsNotExist(err):
		return err
	}
	tx.backups = append(tx.backups, b)
	return nil
}

// rememberPostconf records the current main.cf values of keys an apply is
// about to set or remove. `postconf -n` prints only explicitly set keys.
func (tx *applyTx) rememberPostconf(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	out, err := runApplyCommand(ctx, tx.execArgv(append([]string{"postconf", "-n"}, keys...)))
	if err != nil {
		return err
	}
	set := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || strings.Contains(line, "warning:") {
			continue
		}
		key = strings.TrimSpace(key)
		set[key] = true
		tx.postconf = append(tx.postconf, key+"="+strings.TrimSpace(value))
	}
	for _, key := range keys {
		if !set[key] {
			tx.postconfX = append(tx.postconfX, key)
		}
	}
	return nil
}

// rollback restores every changed file and main.cf value. It runs on its own
// timeout because the apply's context may be what ran out. It returns a note
// for the status message.
func (tx *applyTx) rollback() string {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var failed []string
	for i := len(tx.backups) - 1; i >= 0; i-- {
		if err := tx.restore(ctx, tx.backups[i]); err != nil {
			failed = append(failed, fmt.Sprintf("%s (%v)", tx.backups[i].target, err))
		}
	}
	if len(tx.postconf) > 0 {
		if _, err := runApplyCommand(ctx, tx.execArgv(append([]string{"postconf", "-e"}, tx.postconf...))); err != nil {
			failed = append(failed, fmt.Sprintf("main.cf (%v)", err))
		}
	}
	if len(tx.postconfX) > 0 {
		if _, err := runApplyCommand(ctx, tx.execArgv(append([]string{"postconf", "-X"}, tx.postconfX...))); err != nil {
			failed = append(failed, fmt.Sprintf("main.cf (%v)", err))
		}
	}
	if len(tx.backups) == 0 && len(tx.postconf) == 0 && len(tx.postconfX) == 0 {
		return ""
	}
	if len(failed) > 0 {
		return "could not restore " + strings.Join(failed, ", ")
	}
	return "previous config restored"
}

func (tx *applyTx) restore(ctx context.Context, b fileBackup) error {
	if !b.existed {
		if err := os.Remove(b.target); err != nil && !os.IsNotExist(err) {
			return err
		}
		if b.dest != "" {
			return removeInContainer(ctx, tx.cli, tx.container, b.dest)
		}
		return nil
	}
	if err := os.WriteFile(b.target, b.content, b.mode); err != nil {
		return err
	}
	// WriteFile keeps the mode of a file that still exists.
	if err := os.Chmod(b.target, b.mode); err != nil {
		return err
	}
	if b.dest != "" {
		if _, err := captureProcess(ctx, []string{tx.cli, "cp", b.target, tx.container + ":" + b.dest}, true); err != nil {
			return err
		}
	}
	return nil
}

// removeInContainer deletes a file in the container. Minimal images ship no
// rm, so it falls back to emptying the file, which every managed service
// reads as no settings.
func removeInContainer(ctx context.Context, cli, container, dest string) error {
	if _, err := captureProcess(ctx, []string{cli, "exec", container, "rm", "-f", dest}, true); err == nil {
		return nil
	}
	empty, err := os.CreateTemp("", "robin-agent-empty-")
	if err != nil {
		return err
	}
	empty.Close()
	defer os.Remove(empty.Name())
	if err := os.Chmod(empty.Name(), 0o644); err != nil {
		return err
	}
	_, err = captureProcess(ctx, []string{cli, "cp", empty.Name(), container + ":" + dest}, true)
	return err
}

// postconfKeys returns the keys of `key=value` postconf arguments.
func postconfKeys(args []string) []string {
	keys := make([]string, 0, len(args))
	for _, arg := range args {
		key, _, _ := strings.Cut(arg, "=")
		keys = append(keys, key)
	}
	return keys
}
