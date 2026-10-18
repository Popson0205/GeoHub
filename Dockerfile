# Single-service build: React frontend + FastAPI backend in one image (used by Railway from the repo root).
# The API is served under /api and the built web app at /.

# ---- 1. build the frontend ----
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ENV VITE_USE_MOCK=false VITE_API_URL=/api
RUN npm run build

# ---- 2. API image + built frontend ----
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.9.3
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip postgresql-client curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY backend/requirements.txt .
RUN pip install --break-system-packages --ignore-installed -r requirements.txt
COPY backend/app ./app
COPY backend/migrations ./migrations
COPY --from=web /web/dist ./web
ENV API_PREFIX=/api WEB_DIR=/srv/web
RUN useradd -m hub && chown -R hub /srv
USER hub
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:${PORT:-8000}/api/health || exit 1
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
