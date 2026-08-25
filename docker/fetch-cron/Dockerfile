# Deliberately does NOT run `playwright install chromium` — this container
# never launches its own browser, only connects over CDP to the sibling
# `chromium` service (see ../docker-compose.yml). Saves ~200MB+ and the
# ARM64 Chromium-for-Testing download entirely.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir playwright>=1.50.0

COPY run_fetch.sh /run_fetch.sh
RUN chmod +x /run_fetch.sh

WORKDIR /repo
ENTRYPOINT ["/run_fetch.sh"]
