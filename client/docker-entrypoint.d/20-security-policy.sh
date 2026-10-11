#!/bin/sh
# Write the UI's Content-Security-Policy header into an nginx include, from
# CONTENT_SECURITY_POLICY (the policy) and CONTENT_SECURITY_POLICY_MODE
# (enforce, report-only or off). Runs once per container start.
set -eu

DEFAULT_POLICY="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.sentry.io; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'"
POLICY="${CONTENT_SECURITY_POLICY:-$DEFAULT_POLICY}"
MODE="${CONTENT_SECURITY_POLICY_MODE:-enforce}"
OUT=/tmp/nginx-security-policy.conf

# The policy is written into nginx configuration, so it may not carry quotes,
# variables, braces or line breaks.
case "$POLICY" in
  *'"'*|*'$'*|*'{'*|*'}'*|*'\'*)
    echo "CONTENT_SECURITY_POLICY may not contain quotes, \$, braces or backslashes" >&2
    exit 1
    ;;
esac
if [ "$(printf '%s' "$POLICY" | wc -l)" -ne 0 ]; then
  echo "CONTENT_SECURITY_POLICY must be a single line" >&2
  exit 1
fi

case "$MODE" in
  enforce) HEADER=Content-Security-Policy ;;
  report-only) HEADER=Content-Security-Policy-Report-Only ;;
  off) : > "$OUT"; echo "Content-Security-Policy is off"; exit 0 ;;
  *) echo "CONTENT_SECURITY_POLICY_MODE must be enforce, report-only or off (got '$MODE')" >&2; exit 1 ;;
esac

printf 'add_header %s "%s" always;\n' "$HEADER" "$POLICY" > "$OUT"
echo "Content-Security-Policy: $MODE"
