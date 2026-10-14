#!/bin/sh
# Startup check of the frontend (nginx) container. The image's entrypoint runs it after
# 20-envsubst-on-templates.sh has rendered /etc/nginx/conf.d/vms.conf; a failure stops the container
# with a message that names the setting, instead of nginx starting with a configuration that answers
# nobody (an unset VMS_SERVER_NAME would otherwise become a literal server name).
set -eu

ME=$(basename "$0")
CONF=/etc/nginx/conf.d/vms.conf
TLS_DIR=/etc/nginx/tls

fail() {
    echo "$ME: ERROR: $*" >&2
    exit 1
}

[ -n "${VMS_SERVER_NAME:-}" ] ||
    fail "VMS_SERVER_NAME is not set: the public host name(s) of the application, e.g. vms.example.com (deploy/env/frontend.env)"
for name in $VMS_SERVER_NAME; do
    case "$name" in
        *[!A-Za-z0-9.-]* | .* | *. | -* | *- | *..*)
            fail "VMS_SERVER_NAME: '$name' is not a host name (letters, digits, dots and hyphens; separate several names with spaces)"
            ;;
    esac
done

# check_upstream NAME VALUE DEFAULT: VALUE must be host:port (one colon, a numeric port).
check_upstream() {
    case "$2" in
        '' | *[!A-Za-z0-9.:_-]* | :* | *: | *:*:*)
            fail "$1 must be host:port of an API instance (default $3)"
            ;;
    esac
    case "${2##*:}" in
        '' | *[!0-9]* | "$2")
            fail "$1 must be host:port of an API instance (default $3)"
            ;;
    esac
}
# The three API instances (deploy/README.md §4): main, reception lists, reports.
check_upstream VMS_API_UPSTREAM "${VMS_API_UPSTREAM:-}" backend:8000
check_upstream VMS_API_RECEPTION_UPSTREAM "${VMS_API_RECEPTION_UPSTREAM:-}" backend-reception:8000
check_upstream VMS_API_REPORTS_UPSTREAM "${VMS_API_REPORTS_UPSTREAM:-}" backend-reports:8000

[ -n "${NGINX_LOCAL_RESOLVERS:-}" ] ||
    fail "no DNS resolver found in /etc/resolv.conf (NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 must stay set)"

[ -f "$CONF" ] || fail "$CONF was not rendered from /etc/nginx/templates/vms.conf.template"
# A literal "${": envsubst leaves an unset variable's placeholder as it was.
# shellcheck disable=SC2016
if grep -n '\${' "$CONF" >&2; then
    fail "$CONF still contains unsubstituted variables (lines above)"
fi

for file in "$TLS_DIR/tls.crt" "$TLS_DIR/tls.key"; do
    [ -r "$file" ] ||
        fail "$file is missing or not readable by uid $(id -u): mount the certificate chain (tls.crt) and its key (tls.key) at $TLS_DIR (deploy/README.md)"
done

echo "$ME: configuration for '$VMS_SERVER_NAME' (API at $VMS_API_UPSTREAM, reception lists at $VMS_API_RECEPTION_UPSTREAM, reports at $VMS_API_REPORTS_UPSTREAM) is complete"
