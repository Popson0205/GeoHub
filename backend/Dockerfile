FROM ghcr.io/osgeo/gdal:ubuntu-small-3.9.3
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip postgresql-client curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install --break-system-packages --ignore-installed -r requirements.txt
COPY app ./app
COPY migrations ./migrations
RUN useradd -m hub && chown -R hub /srv
USER hub
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:8000/health || exit 1
# Migrations run automatically on startup. PORT is honoured for hosts like Railway/Render.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
