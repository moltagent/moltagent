#!/usr/bin/env bash
# .claude/hooks/verify-built.sh
# Enforces Moltagent principle: BUILT ≠ VERIFIED.
# Blocks Stop if no [VERIFIED: ...] tag is present in the final assistant message.
# See moltagent-dev-rules.md § Verification Gate.

set -euo pipefail

INPUT=$(cat)

# Loop prevention: if we've already blocked once this session, allow stop
# to avoid thrashing. Fu can re-invoke manually if verification is still missing.
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# Extract the final assistant message. Try a direct field first; fall back to
# the session transcript if the direct field is empty or absent.
LAST_MESSAGE=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')

if [ -z "$LAST_MESSAGE" ]; then
  TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')
  if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    # Transcript is JSONL. Slurp it, take the last assistant message, extract text.
    # Handles both top-level .role and nested .message.role; handles content as
    # string or as an array of {type:"text", text:"..."} blocks.
    LAST_MESSAGE=$(jq -rs '
      [.[] | select((.role // .message.role // "") == "assistant")]
      | if length == 0 then "" else .[-1] end
      | (.message.content // .content // "")
      | if type == "string" then .
        elif type == "array" then [.[] | select(.type == "text") | .text] | join(" ")
        else "" end
    ' "$TRANSCRIPT_PATH" 2>/dev/null || echo "")
  fi
fi

# If we still have no message to check, fail open rather than blocking on an
# environment issue. A session that never produced an assistant message has
# nothing meaningful to verify anyway.
if [ -z "$LAST_MESSAGE" ]; then
  exit 0
fi

# Check for the marker
if echo "$LAST_MESSAGE" | grep -q '\[VERIFIED:'; then
  exit 0
fi

# No marker — block Stop with specific counter-action guidance
cat >&2 <<'EOF'
STOP BLOCKED: BUILT ≠ VERIFIED

Your final message does not contain a [VERIFIED: ...] tag.

Per moltagent-dev-rules.md § Verification Gate:
- A feature is only complete after confirmed production behavior.
- Green tests can mask silent runtime failures (demonstrated twice with
  WikiSteward: 220/220 passing, constructor path null at runtime).
- Live verification queries are mandatory, not optional.

Required before Stop:
  1. Run each command listed in the briefing's "Verification Gate" section.
  2. Capture the real output (not assumed output).
  3. Include a [VERIFIED: <one-line summary of what you ran + key observed result>]
     line somewhere in your response.

Example:
  [VERIFIED: npm run lint -> exit 0, no warnings. npm test -> 47/47 passed.
   Branch feat/cc-foundation pushed to origin. PR #NN opened against next.
   Hook script tested with all three input cases: block, allow, loop-prevent.]

If verification reveals the fix does not work in production, say so explicitly
and return to systematic debugging — do not declare done.

For a session with no code changes (pure discussion, planning, reading):
  [VERIFIED: no code changes in this session]

Continue the session with verification now.
EOF

exit 2
