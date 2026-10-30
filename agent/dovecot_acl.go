package main

import (
	"fmt"
	"regexp"
	"strings"
)

var aclMailboxPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$`)
var aclAddressPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+=-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]{0,188}[A-Za-z0-9]$`)

var aclRights = map[string]bool{
	"lookup": true, "read": true, "write": true, "write-seen": true,
	"write-deleted": true, "insert": true, "post": true, "expunge": true,
	"create": true, "delete": true,
}

func aclBaseArgs(args map[string]any) (string, string, error) {
	user, err := userArg(args)
	if err != nil || !aclAddressPattern.MatchString(user) {
		return "", "", fmt.Errorf("a full owner address is required")
	}
	mailbox, _ := args["mailbox"].(string)
	if !aclMailboxPattern.MatchString(mailbox) {
		return "", "", fmt.Errorf("mailbox must be a plain mailbox name, not a pattern")
	}
	for _, part := range strings.Split(mailbox, "/") {
		if part == "" || part == "." || part == ".." {
			return "", "", fmt.Errorf("mailbox must not contain traversal components")
		}
	}
	return user, mailbox, nil
}

func aclGet(args map[string]any) ([][]string, error) {
	user, mailbox, err := aclBaseArgs(args)
	if err != nil {
		return nil, err
	}
	return [][]string{{"doveadm", "-f", "tab", "acl", "get", "-u", user, mailbox}}, nil
}

func aclChange(operation string) func(map[string]any) ([][]string, error) {
	return func(args map[string]any) ([][]string, error) {
		user, mailbox, err := aclBaseArgs(args)
		if err != nil {
			return nil, err
		}
		member, _ := args["member"].(string)
		if !userPattern.MatchString(member) || !aclAddressPattern.MatchString(member) || strings.EqualFold(member, user) {
			return nil, fmt.Errorf("member must be a different full mailbox address")
		}
		change := []string{"doveadm", "acl", operation, "-u", user, mailbox, "user=" + member}
		if operation == "set" {
			raw, ok := args["rights"].([]any)
			if !ok || len(raw) == 0 || len(raw) > len(aclRights) {
				return nil, fmt.Errorf("rights must list 1-%d supported ACL rights", len(aclRights))
			}
			seen := map[string]bool{}
			for _, value := range raw {
				right, ok := value.(string)
				if !ok || !aclRights[right] || seen[right] {
					return nil, fmt.Errorf("invalid or duplicate ACL right")
				}
				seen[right] = true
				change = append(change, right)
			}
		}
		readback, _ := aclGet(args)
		return append([][]string{change}, readback...), nil
	}
}
