package main

import (
	"reflect"
	"testing"
)

func TestDovecotACLFixedCommandsAndReadback(t *testing.T) {
	args := map[string]any{"user": "owner@example.test", "mailbox": "INBOX", "member": "member@example.test", "rights": []any{"lookup", "read", "write-seen"}}
	get := []string{"doveadm", "-f", "tab", "acl", "get", "-u", "owner@example.test", "INBOX"}
	for action, want := range map[string][][]string{
		"dovecot.acl.get":    {get},
		"dovecot.acl.set":    {{"doveadm", "acl", "set", "-u", "owner@example.test", "INBOX", "user=member@example.test", "lookup", "read", "write-seen"}, get},
		"dovecot.acl.delete": {{"doveadm", "acl", "delete", "-u", "owner@example.test", "INBOX", "user=member@example.test"}, get},
	} {
		got, err := commandSpecs[action].build(args)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("%s = %v, %v; want %v", action, got, err, want)
		}
	}
}

func TestDovecotACLRejectsUnsafeTargetsAndRights(t *testing.T) {
	for key, badValues := range map[string][]any{
		"user":    {"-A", "*@example.test", "owner@example.test;id", "local", "a@b@example.test"},
		"member":  {"anyone", "-A", "member@example.test;id", "owner@example.test", "a@b@example.test"},
		"mailbox": {"*", "INBOX;id", "-A", "../INBOX", "INBOX/../Other", "INBOX\nOther", "INBOX//Other"},
		"rights":  {[]any{}, []any{"admin"}, []any{"lookup", "lookup"}, []any{"read;id"}, []any{1}},
	} {
		for _, bad := range badValues {
			args := map[string]any{"user": "owner@example.test", "member": "member@example.test", "mailbox": "INBOX", "rights": []any{"lookup", "read"}}
			args[key] = bad
			if _, err := commandSpecs["dovecot.acl.set"].build(args); err == nil {
				t.Fatalf("accepted unsafe %s=%v", key, bad)
			}
		}
	}
}

func TestDovecotACLRequiresBackendCapability(t *testing.T) {
	c := config{}
	svc := ownedService{ServiceID: "imap", ServiceType: "dovecot", CollectMetrics: true}
	actions := serviceActions(c, svc, func(_, tool string) bool {
		return tool != "action:dovecot.acl.get" && tool != "action:dovecot.acl.set" && tool != "action:dovecot.acl.delete"
	})
	for _, action := range actions {
		if action == "dovecot.acl.get" || action == "dovecot.acl.set" || action == "dovecot.acl.delete" {
			t.Fatal("ACL actions must not be advertised without the backend ACL plugin")
		}
	}
}

func TestDovecotACLProbeRefusesDisabledPlugin(t *testing.T) {
	for _, output := range []string{"Unknown command 'acl'", "Fatal: ACL not enabled", "acl plugin is not loaded"} {
		if dovecotAclProbe.accepts(output) {
			t.Fatalf("advertised unusable ACL plugin: %s", output)
		}
	}
	if !dovecotAclProbe.accepts("user robin-agent-probe doesn't exist") {
		t.Fatal("an absent synthetic probe user must not hide an installed ACL command")
	}
}
