# FreeAudit — container image for hosted use.
#
# The audit drives a real Chromium against Fullbay (which has no API) and a run
# takes minutes, so this must run as a long-lived service with a writable disk —
# NOT on serverless/edge. Render, Railway, Fly.io, ECS, or any VM all work.
#
# The base image is Microsoft's official Playwright image, which already carries
# the matching browser build and its system libraries. Keep this tag in step with
# the "playwright" version in package.json — a mismatch means Chromium won't launch.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

ENV NODE_ENV=production
# Where per-user/per-run data goes. Mount a persistent volume here: it holds the
# saved Fullbay/Vorto browser sessions, so losing it means everyone logs in again.
ENV FREEAUDIT_DATA_DIR=/data
# No display in a container, so the browser must run headless. On a desktop
# install this is false, because a person may need to complete a login by hand.
ENV FREEAUDIT_HEADLESS=true

WORKDIR /app

# Dependencies first, so code edits don't bust the npm layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code. Data files are excluded by .dockerignore.
COPY . .

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 4477
CMD ["node", "server.js"]
