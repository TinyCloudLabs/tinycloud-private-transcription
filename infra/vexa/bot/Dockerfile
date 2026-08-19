# Derived Vexa bot image: upstream published bot + our dev CA in Chromium's NSS trust store.
# No upstream sources are modified — this only adds trust for the local Jitsi's TLS cert.
# The upstream bot deliberately launches Chromium WITHOUT --ignore-certificate-errors (bot-detection
# hygiene on Google Meet), so a self-signed local Jitsi is unreachable unless its CA is trusted.
# The bot runs as root with HOME=/root, so Chromium reads /root/.pki/nssdb.
ARG UPSTREAM_BOT_IMAGE=vexaai/vexa-bot:v012
FROM ${UPSTREAM_BOT_IMAGE}
COPY ca.crt /usr/local/share/ca-certificates/ptx-dev-ca.crt
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libnss3-tools ca-certificates >/dev/null \
 && update-ca-certificates >/dev/null \
 && mkdir -p /root/.pki/nssdb \
 && certutil -d sql:/root/.pki/nssdb -N --empty-password \
 && certutil -d sql:/root/.pki/nssdb -A -t "C,," -n ptx-dev-ca -i /usr/local/share/ca-certificates/ptx-dev-ca.crt \
 && certutil -d sql:/root/.pki/nssdb -L | grep -q ptx-dev-ca \
 && rm -rf /var/lib/apt/lists/*
