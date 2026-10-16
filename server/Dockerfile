# syntax=docker/dockerfile:1
# Builds sblurp-server for linux/amd64. Build from this directory:
#   docker build --platform linux/amd64 -t sblurp-server .
#
# Without R2 keys it just runs the server. With AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET and RESTIC_PASSWORD set (for
# example with `fly secrets set`), it backs up to Cloudflare R2:
#   - sblurp.db: Litestream, every change within 10 s.
#   - file-key and files/: restic, encrypted, every hour.
# On a fresh volume it restores both from R2 before the server starts.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
WORKDIR /src
RUN wget -qO /tmp/ls.tgz https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-x86_64.tar.gz && \
	echo "cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d  /tmp/ls.tgz" | sha256sum -c - && \
	tar -xzf /tmp/ls.tgz -C /usr/local/bin litestream
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOWORK=off go build -trimpath -ldflags="-s -w" -o /sblurp-server ./cmd/sblurp-server

FROM --platform=linux/amd64 alpine:3.22
RUN apk add --no-cache ca-certificates restic
COPY --from=build /usr/local/bin/litestream /usr/local/bin/
COPY --from=build /sblurp-server /sblurp-server

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

COPY --chmod=755 <<'EOF' /entrypoint.sh
#!/bin/sh
set -eu
[ -n "${AWS_ACCESS_KEY_ID:-}" ] || exec /sblurp-server
export RESTIC_REPOSITORY="s3:$R2_ENDPOINT/$R2_BUCKET/$BACKUP_NAME/restic"
restic cat config >/dev/null 2>&1 || restic init
# A fresh volume: get the file key and uploads back before the server makes a new key.
if [ ! -e /data/file-key ] && [ "$(restic snapshots --json --latest 1)" != "[]" ]; then
	restic restore latest --target /
fi
litestream restore -if-db-not-exists -if-replica-exists /data/sblurp.db
# ponytail: hourly restic loop, so up to an hour of uploads can be lost; Fly's daily volume snapshots also cover them.
(
	sleep 60
	while :; do
		restic unlock -q
		restic backup -q /data/file-key /data/files || echo "restic backup failed"
		restic forget -q --prune --keep-hourly 24 --keep-daily 7 --keep-weekly 4 --keep-monthly 12 || echo "restic forget failed"
		sleep 3600
	done
) &
exec litestream replicate -exec /sblurp-server
EOF

ENV SBLURP_DATA=/data SBLURP_ADDR=:8080 BACKUP_NAME=community
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
