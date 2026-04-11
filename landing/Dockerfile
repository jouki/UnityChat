# UnityChat landing + /UnityChat install page container
# Build context is the REPO ROOT (Coolify base_directory = "/").
# Dockerfile lives in landing/ but references paths from repo root.

# -------- Stage 1: zip the extension folder for download --------
FROM alpine:3 AS zipper
WORKDIR /work
RUN apk add --no-cache zip
COPY extension ./extension
# Strip any dev cruft before zipping
RUN find ./extension -type f \( -name '.DS_Store' -o -name '*.log' \) -delete \
 && cd extension \
 && zip -r /work/unitychat.zip . -x "*.DS_Store" "*.log"

# -------- Stage 2: nginx runtime --------
FROM nginx:alpine

RUN apk add --no-cache curl \
 && rm /etc/nginx/conf.d/default.conf

# Root landing (under construction)
COPY landing/index.html /usr/share/nginx/html/index.html

# /UnityChat install page + iframe preview
COPY landing/unitychat /usr/share/nginx/html/unitychat

# Real extension CSS for the iframe preview (so the mockup looks like
# the actual side panel, pixel-for-pixel, without duplicating styles)
COPY extension/sidepanel.css /usr/share/nginx/html/unitychat/assets/sidepanel.css
COPY extension/icons         /usr/share/nginx/html/unitychat/assets/icons

# Downloadable ZIP + manifest.json (JS on the landing page reads the
# manifest to display the real current version)
COPY --from=zipper /work/unitychat.zip /usr/share/nginx/html/download/unitychat.zip
COPY extension/manifest.json           /usr/share/nginx/html/download/manifest.json

# Nginx config (case-insensitive /UnityChat routing, download rules, etc.)
COPY landing/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://localhost/ > /dev/null || exit 1
