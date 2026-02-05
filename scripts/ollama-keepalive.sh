#!/bin/bash
# Ollama keep-alive: prevents model unloading after idle timeout
# Run every 4 minutes via systemd timer or cron
# Without this, the model unloads after 5 min idle, causing 60-90s cold starts
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:8b}"
curl -s --max-time 120 "$OLLAMA_URL/api/generate" \
  -d "{\"model\":\"$OLLAMA_MODEL\",\"prompt\":\"hi\",\"stream\":false}" \
  > /dev/null 2>&1
