#!/bin/bash
# Knowledge Pipeline Test Suite — 5 probes to diagnose knowledge quality
# Sends signed webhook requests to localhost:3000 and captures pipeline logs

SECRET="7d02a6d8a79d17636424b73013900ed6ad8054a610843a905ae2b42a8834023039e256db2204056680c9bf438f821eb27dc6eabc875c6768c5ee7754bda51aaf"
BACKEND="https://YOUR_NEXTCLOUD_URL"
ROOM="strte9d4"
PORT=3000
LOG_DIR="/tmp/knowledge-tests-$(date +%Y%m%d-%H%M%S)"

mkdir -p "$LOG_DIR"

send_message() {
  local test_num="$1"
  local message="$2"
  local msg_id="test-$(date +%s)-${test_num}"
  local random_hex=$(openssl rand -hex 32)

  local body=$(cat <<ENDJSON
{"type":"Create","actor":{"type":"Person","id":"users/Funana","name":"Funana"},"object":{"type":"Note","id":"${msg_id}","name":"","content":"${message}","mediaType":"text/markdown","message":{"id":"${msg_id}","token":"${ROOM}","actorType":"users","actorId":"Funana","actorDisplayName":"Funana","message":"${message}","messageParameters":{}}},"target":{"type":"Collection","id":"${ROOM}","name":"Test Room"}}
ENDJSON
)

  local signature=$(printf '%s' "${random_hex}${body}" | openssl dgst -sha256 -hmac "$SECRET" -hex 2>/dev/null | awk '{print $NF}')

  echo ">>> Sending TEST ${test_num}: ${message}"

  curl -s -X POST "http://localhost:${PORT}/webhook/nctalk" \
    -H "Content-Type: application/json" \
    -H "X-Nextcloud-Talk-Signature: ${signature}" \
    -H "X-Nextcloud-Talk-Random: ${random_hex}" \
    -H "X-Nextcloud-Talk-Backend: ${BACKEND}" \
    -d "$body" \
    -o "$LOG_DIR/response-${test_num}.txt" \
    -w "HTTP %{http_code} in %{time_total}s\n"
}

echo "======================================"
echo "Knowledge Pipeline Test Suite"
echo "Log dir: $LOG_DIR"
echo "======================================"

# Start capturing journal logs in background
journalctl -u moltagent -f --since "now" > "$LOG_DIR/full-pipeline.log" 2>&1 &
JOURNAL_PID=$!

sleep 1

# TEST 1: Probe saturation — too many similar pages?
send_message 1 "What is HeartbeatManager?"
echo "  Waiting 30s for pipeline..."
sleep 30

# TEST 2: Entity confusion — people vs projects
send_message 2 "Who works on Moltagent?"
echo "  Waiting 30s for pipeline..."
sleep 30

# TEST 3: Stale data — deleted/updated content still served?
send_message 3 "What is OpenClaw?"
echo "  Waiting 30s for pipeline..."
sleep 30

# TEST 4: Technical depth — document ingestion
send_message 4 "How does document ingestion work?"
echo "  Waiting 30s for pipeline..."
sleep 30

# TEST 5: Cross-section coherence — multiple sources for same entity
send_message 5 "What do you know about Hetzner?"
echo "  Waiting 30s for pipeline..."
sleep 30

# Kill journal capture
kill $JOURNAL_PID 2>/dev/null
wait $JOURNAL_PID 2>/dev/null

echo ""
echo "======================================"
echo "PIPELINE LOG ANALYSIS"
echo "======================================"

# Extract per-test sections from the log
for i in 1 2 3 4 5; do
  echo ""
  echo "--- TEST $i ---"
  case $i in
    1) echo "QUESTION: What is HeartbeatManager?" ;;
    2) echo "QUESTION: Who works on Moltagent?" ;;
    3) echo "QUESTION: What is OpenClaw?" ;;
    4) echo "QUESTION: How does document ingestion work?" ;;
    5) echo "QUESTION: What do you know about Hetzner?" ;;
  esac

  echo "RESPONSE:"
  cat "$LOG_DIR/response-${i}.txt" 2>/dev/null
  echo ""
done

echo ""
echo "--- FULL PIPELINE LOG (filtered) ---"
grep -E "From:|Smart-mix|Knowledge|knowledge|probe|Probe|enrich|Enricher|synthesis|Synthesis|wiki.*search|search.*term|results|provenance|Provenance|chat_outgoing|AUDIT.*signature" "$LOG_DIR/full-pipeline.log" 2>/dev/null

echo ""
echo "--- RAW COUNTS ---"
echo "Signature verifications: $(grep -c 'signature_verified' "$LOG_DIR/full-pipeline.log" 2>/dev/null)"
echo "Knowledge queries: $(grep -c 'Knowledge query' "$LOG_DIR/full-pipeline.log" 2>/dev/null)"
echo "Probe mentions: $(grep -ci 'probe' "$LOG_DIR/full-pipeline.log" 2>/dev/null)"
echo "Enrichment mentions: $(grep -ci 'enrich' "$LOG_DIR/full-pipeline.log" 2>/dev/null)"
echo "Chat outgoing: $(grep -c 'chat_outgoing' "$LOG_DIR/full-pipeline.log" 2>/dev/null)"
echo ""
echo "Full logs saved to: $LOG_DIR/"
echo "  full-pipeline.log  — all journal output"
echo "  response-{1-5}.txt — HTTP responses"
