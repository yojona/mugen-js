# Runs the original MUGEN 1.1b1 under Wine on a virtual X display.
# Build:  docker build --platform linux/amd64 -t mugen-harness tools/harness
FROM --platform=linux/amd64 debian:bookworm-slim
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends wine wine32 xvfb xdotool x11-utils procps python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV WINEDEBUG=-all WINEPREFIX=/wine DISPLAY=:99
RUN wineboot --init 2>/dev/null; wineserver -w || true
COPY drive.sh /drive.sh
COPY memread.py /memread.py
COPY drive.py /drive.py
RUN chmod +x /drive.sh /memread.py /drive.py
ENTRYPOINT ["python3", "/drive.py"]
