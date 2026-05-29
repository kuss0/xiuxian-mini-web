# Dockerfile for Xiuxian Mini Web
# Multi-stage build for smaller image size

# Stage 1: Builder
FROM python:3.13-slim as builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# Stage 2: Runtime
FROM python:3.13-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy Python dependencies from builder
COPY --from=builder /root/.local /root/.local

# Copy application code
COPY backend/ ./backend/
COPY web/ ./web/

# Create necessary directories (data will be mounted as volume)
RUN mkdir -p data logs

# Set environment variables
ENV PATH=/root/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    MINIWEB_HOST=0.0.0.0 \
    MINIWEB_PORT=8787

# Expose port
EXPOSE 8787

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8787/api/health || exit 1

# Run application
CMD ["python", "backend/app.py", "--host", "0.0.0.0", "--port", "8787"]
