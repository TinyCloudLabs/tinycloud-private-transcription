FROM oven/bun:1.3-debian

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl ffmpeg gnupg jq pulseaudio pulseaudio-utils xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/*

# Signal's signed Desktop repository. The profile is mounted separately, so rebuilding this image
# cannot create, link, or erase an account.
RUN curl -fsSL https://updates.signal.org/desktop/apt/keys.asc | gpg --dearmor -o /usr/share/keyrings/signal-desktop-keyring.gpg \
    && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/signal-desktop-keyring.gpg] https://updates.signal.org/desktop/apt xenial main' > /etc/apt/sources.list.d/signal-xenial.list \
    && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends signal-desktop \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ptx
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY infra/signal-seat/boot.sh infra/signal-seat/signal-transcriber ./
RUN chmod 0755 boot.sh signal-transcriber && mkdir -p /var/lib/signal

ENTRYPOINT ["/opt/ptx/boot.sh"]
