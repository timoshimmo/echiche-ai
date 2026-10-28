# Echiche worker image (ADR-005: Render Background Worker, Frankfurt).
# Build context is the REPO ROOT (the image needs prompts/runtime and config/routing-policy.json as well as worker/):
#   docker build -f worker/Dockerfile -t echiche-worker .
# The root .dockerignore whitelists only what this image needs. Runs as a non-root user;
# PID 1 is the worker itself so SIGTERM reaches its graceful-shutdown handler directly.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    ECHICHE_PROMPTS_DIR=/app/prompts/runtime \
    ECHICHE_ROUTING_POLICY=/app/config/routing-policy.json

RUN pip install --no-cache-dir uv==0.11.32

WORKDIR /app
# Dependencies first (cached layer), then the project itself.
COPY worker/pyproject.toml worker/uv.lock worker/README.md ./
RUN uv sync --locked --no-dev --no-install-project
COPY worker/src ./src
RUN uv sync --locked --no-dev
# Reviewed, versioned prompts (read-only at runtime; ADR-007).
COPY prompts/runtime ./prompts/runtime
# The same versioned routing policy the web app classifies with (ADR-010).
COPY config/routing-policy.json ./config/routing-policy.json

RUN useradd --system --uid 10001 --no-create-home worker
USER worker

CMD ["/app/.venv/bin/echiche-worker"]
