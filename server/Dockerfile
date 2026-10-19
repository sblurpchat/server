# syntax=docker/dockerfile:1
# Builds sblurp-server for linux/amd64 and linux/arm64. Build from this directory:
#   docker buildx build --platform linux/amd64,linux/arm64 -t sblurp-server .
#
# Without R2 keys it just runs the server. With AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET and BACKUP_PASSWORD set (for
# example with `fly secrets set`), it backs up to Cloudflare R2:
#   - sblurp.db: Litestream, every change within 10 s.
#   - file-key and files/: restic, encrypted, every hour.
# On a fresh volume it restores both from R2 before the server starts.
#
# Base image: Chainguard wolfi-base. It is free, rebuilt every night, has
# near-zero CVEs, and Wolfi packages restic (rebuilt with current Go). We need a shell for the
# entrypoint, so chainguard/static and distroless (no shell, no packages) do
# not fit. Docker Hardened Images are also free but need a Docker Hub login
# to pull. The free tier only has :latest, so we pin a digest and Dependabot
# bumps it.
#
# Go binaries cross-compile on the build host (no QEMU). Only the small
# `apk add` runs per target platform.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS go

# Wolfi's litestream is stale (0.5.12, old Go, ~90 CVEs in a scan), so build
# the release from source with current Go and patched network/crypto
# modules. The Go checksum database verifies every module.
FROM go AS litestream
ARG TARGETOS TARGETARCH
WORKDIR /ls
RUN go mod init ls && go get github.com/benbjohnson/litestream/cmd/litestream@v0.5.17 \
	golang.org/x/net@v0.61.0 golang.org/x/crypto@v0.58.0 google.golang.org/grpc@v1.84.0 go.opentelemetry.io/otel@v1.47.0 go.opentelemetry.io/otel/sdk@v1.47.0 && \
	CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X main.Version=v0.5.17" \
	-o /out/litestream github.com/benbjohnson/litestream/cmd/litestream

FROM go AS build
ARG TARGETOS TARGETARCH
# Set by the release workflow; see .github/workflows/server-release.yml.
ARG VERSION=dev TRACK=head UPDATE_URL=
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOWORK=off go build -trimpath \
	-ldflags="-s -w -X main.version=$VERSION -X main.track=$TRACK -X main.updateURL=$UPDATE_URL" \
	-o /out/sblurp-server ./cmd/sblurp-server && mkdir /out/data

FROM cgr.dev/chainguard/wolfi-base:latest@sha256:256c88bb066424045021090932d50be93c8e3f2ce3586707702a401b146f3e43
RUN apk add --no-cache restic su-exec
COPY --from=litestream /out/litestream /usr/bin/litestream
COPY --from=build /out/sblurp-server /usr/bin/sblurp-server
# A new Docker volume copies this owner.
COPY --from=build --chown=65532:65532 /out/data /data

COPY <<'EOF' /etc/litestream.yml
access-key-id: ${AWS_ACCESS_KEY_ID}
secret-access-key: ${AWS_SECRET_ACCESS_KEY}
# Lose at most 10 s of writes; keeps R2 writes inside the free tier.
sync-interval: 10s
dbs:
  - path: /data/sblurp.db
    replica:
      type: s3
      endpoint: ${R2_ENDPOINT}
      region: auto
      bucket: ${R2_BUCKET}
      path: ${BACKUP_NAME}/sblurp.db
EOF

COPY --chmod=755 <<'EOF' /usr/bin/sblurp-backup
#!/bin/sh
# Runs restic (the file backup tool) on this app's R2 backup, for example
# `sblurp-backup snapshots`, `sblurp-backup check` or `sblurp-backup restore latest --target /`.
# BACKUP_PASSWORD is the user-facing name; RESTIC_PASSWORD still works.
export RESTIC_PASSWORD="${BACKUP_PASSWORD:-${RESTIC_PASSWORD:-}}"
export RESTIC_REPOSITORY="s3:$R2_ENDPOINT/$R2_BUCKET/$BACKUP_NAME/restic"
exec restic "$@"
EOF

COPY --chmod=755 <<'EOF' /entrypoint.sh
#!/bin/sh
set -eu
# Fly mounts volumes owned by root, and the image starts as root there. Fix
# the owner once, then run everything as nonroot (65532). Compose and Podman
# start as 65532 directly (user: in the compose file).
if [ "$(id -u)" = 0 ]; then
	[ "$(stat -c %u /data)" = 65532 ] || chown -R 65532:65532 /data
	exec su-exec 65532:65532 "$0" "$@"
fi
[ -n "${AWS_ACCESS_KEY_ID:-}" ] || exec sblurp-server
sblurp-backup cat config >/dev/null 2>&1 || sblurp-backup init
# A fresh volume: get the file key and uploads back before the server makes a new key.
if [ ! -e /data/file-key ] && [ "$(sblurp-backup snapshots --json --latest 1)" != "[]" ]; then
	sblurp-backup restore latest --target /
fi
litestream restore -if-db-not-exists -if-replica-exists /data/sblurp.db
# ponytail: hourly restic loop, so up to an hour of uploads can be lost; Fly's daily volume snapshots also cover them.
(
	sleep 60
	while :; do
		sblurp-backup unlock -q
		sblurp-backup backup -q /data/file-key /data/files || echo "restic backup failed"
		sblurp-backup forget -q --prune --keep-hourly 24 --keep-daily 7 --keep-weekly 4 --keep-monthly 12 || echo "restic forget failed"
		sleep 3600
	done
) &
exec litestream replicate -exec sblurp-server
EOF

# The restic cache lives on the volume, so the root filesystem can be read-only.
ENV SBLURP_DATA=/data SBLURP_ADDR=:8080 BACKUP_NAME=community RESTIC_CACHE_DIR=/data/.cache/restic
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
