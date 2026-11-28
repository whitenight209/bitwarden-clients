FROM node:24-bookworm-slim
ARG TARGETARCH
ARG CHROME_VERSION=158.0.8127.88
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl unzip openssl xvfb x11-utils openbox xdotool scrot dbus-x11 fonts-liberation \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 \
  libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 \
  libxkbcommon0 libxrandr2 libxshmfence1 && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in arm64) platform=linux-arm64 ;; amd64) platform=linux64 ;; *) exit 1 ;; esac \
  && curl -fsSL --retry 3 "https://storage.googleapis.com/chrome-for-testing-public/$CHROME_VERSION/$platform/chrome-$platform.zip" -o /tmp/chrome.zip \
  && mkdir -p /opt/cft && unzip -q /tmp/chrome.zip -d /opt/cft \
  && ln -s "/opt/cft/chrome-$platform/chrome" /usr/local/bin/chrome-for-testing \
  && rm /tmp/chrome.zip
WORKDIR /opt/e2e
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY environment.e2e.mjs authenticated.e2e.mjs auth-browser-helpers.mjs test-server.mjs entrypoint.sh ./
ENV DISPLAY=:99
ENTRYPOINT ["bash", "/opt/e2e/entrypoint.sh"]
CMD ["node", "/opt/e2e/environment.e2e.mjs"]
