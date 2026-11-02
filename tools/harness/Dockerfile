# Runs the original MUGEN 1.1b1 under Wine on a virtual X display.
# Build:  docker build --platform linux/amd64 -t mugen-harness tools/harness
FROM --platform=linux/amd64 debian:bookworm-slim
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends wine wine32 xvfb xdotool x11-utils procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV WINEDEBUG=-all WINEPREFIX=/wine DISPLAY=:99
RUN wineboot --init 2>/dev/null; wineserver -w || true
COPY drive.sh /drive.sh
RUN chmod +x /drive.sh
ENTRYPOINT ["/drive.sh"]
