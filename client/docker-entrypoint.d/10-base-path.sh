#!/bin/sh
# Serve the UI under BASE_PATH: copy the build to the writable tmpfs and replace
# the build-time placeholder. Runs once per container start.
set -eu

case "$BASE_PATH" in
  /) ;;
  /*/) ;;
  *) echo "BASE_PATH must start and end with '/', for example / or /admin/ (got '$BASE_PATH')" >&2; exit 1 ;;
esac
if ! printf '%s' "$BASE_PATH" | grep -Eq '^/([A-Za-z0-9._~-]+/)*$'; then
  echo "BASE_PATH may contain only letters, digits and . _ ~ - between slashes (got '$BASE_PATH')" >&2
  exit 1
fi

rm -rf /tmp/html
cp -R /usr/share/robin-admin /tmp/html
find /tmp/html -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.json' -o -name '*.svg' \) \
  -exec sed -i "s#/__ROBIN_ADMIN_BASE__/#${BASE_PATH}#g" {} +
echo "Serving Robin Admin UI under ${BASE_PATH}"
