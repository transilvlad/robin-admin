#!/bin/sh
mode=$(cat /tmp/queue-mode 2>/dev/null || printf up)
printf '%s %s\n' "$mode" "$*" >> /tmp/queue-executions
case "$mode" in
  delay) sleep 3 ;;
  stall) sleep 30 ;;
  inherited) sleep 5 & ;;
  overflow) head -c 4194305 /dev/zero ;;
  fail) printf 'fixture command failure\n' >&2; exit 1 ;;
esac
exit 0
