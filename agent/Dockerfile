# robin-agent — dependency-free static binary in a minimal image.
#
# Targets:
#   runtime (default)  the agent for remote hosts
#   colocated          adds the Docker CLI so an agent next to containerized
#                      services can run their tools with `docker exec`
FROM golang:1.27-alpine AS build
ARG AGENT_VERSION=0.1.0-dev
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.agentVersion=${AGENT_VERSION}" -o /out/robin-agent .

FROM alpine:3.24 AS base
# postgresql-client (psql) and mariadb-client (mariadb) are the clients the
# Postgres and MariaDB metrics collectors shell out to (the agent bundles no
# database driver — it stays a thin executor). Small, and only used when a
# service of that type is assigned to this agent.
# apk upgrade pulls patched OS packages on top of the pinned base.
RUN apk upgrade --no-cache  && apk add --no-cache ca-certificates postgresql-client mariadb-client \
 && adduser -D -u 1000 robinagent \
 && mkdir -p /var/lib/robin-agent \
 && chown robinagent:robinagent /var/lib/robin-agent
COPY --from=build /out/robin-agent /usr/local/bin/robin-agent
VOLUME ["/var/lib/robin-agent"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/robin-agent", "--version"]
ENTRYPOINT ["/usr/local/bin/robin-agent"]

FROM base AS colocated
RUN apk add --no-cache docker-cli
USER robinagent

FROM base AS runtime
USER robinagent
