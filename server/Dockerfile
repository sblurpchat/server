# Builds a static sblurp-server. Build from this directory:
#   docker build -t sblurp-server .
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOWORK=off go build -trimpath -ldflags="-s -w" -o /sblurp-server ./cmd/sblurp-server

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /sblurp-server /sblurp-server
# Runs as root because Fly and most Docker volumes mount root-owned.
ENV SBLURP_DATA=/data SBLURP_ADDR=:8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/sblurp-server"]
