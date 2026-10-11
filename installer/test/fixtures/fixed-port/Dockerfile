FROM nginx:1.31-alpine
COPY default.conf.template /etc/nginx/templates/default.conf.template
ENV FIXTURE_PORT=39437
HEALTHCHECK --interval=1s --timeout=1s --start-period=1s --retries=1 CMD test "$FAIL_HEALTH" != true && wget -q -O /dev/null "http://127.0.0.1:$FIXTURE_PORT/health"
