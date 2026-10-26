# Echiche worker image (ADR-005: Render Background Worker, Frankfurt).
# Build context is ./worker. Runs as a non-root user; PID 1 is the worker itself so
# SIGTERM reaches its graceful-shutdown handler directly.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

RUN pip install --no-cache-dir uv==0.11.32

WORKDIR /app
# Dependencies first (cached layer), then the project itself.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN uv sync --locked --no-dev

RUN useradd --system --uid 10001 --no-create-home worker
USER worker

CMD ["/app/.venv/bin/echiche-worker"]
