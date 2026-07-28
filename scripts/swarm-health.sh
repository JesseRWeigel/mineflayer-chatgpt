#!/usr/bin/env bash
# Swarm health check — one-shot snapshot for the hourly monitoring loop.
#
# Emits KEY=VALUE lines so a caller can diff successive runs cheaply.
# Exit 0 = healthy, 1 = degraded (see ALERTS).
#
# Watches the two regressions fixed 2026-07-25:
#   MS_SOCKETS  — Edge TTS socket leak (5f7f45a). Must stay at 0 or 1.
#                 It reached 4,880 and stalled the event loop for 2.5 days.
#   IDLE_PCT    — critic/planner action-list drift (cb5edfc). Sustained high
#                 idle means bots are falling back instead of deciding.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

ALERTS=()

# ── Process ────────────────────────────────────────────────────────────────
WORKER=$(ps -eo pid,args | grep "tsx/dist/loader.mjs src/index.ts" | grep -v grep | awk '{print $1}' | head -1)

if [[ -z "$WORKER" ]]; then
  echo "SWARM=down"
  echo "ALERTS=swarm_process_missing"
  exit 1
fi

echo "SWARM=up"
echo "WORKER_PID=$WORKER"
echo "UPTIME=$(ps -o etime= -p "$WORKER" | tr -d ' ')"
echo "CPU_PCT=$(ps -o pcpu= -p "$WORKER" | tr -d ' ')"

RSS_MB=$(awk '/VmRSS/{print int($2/1024)}' "/proc/$WORKER/status" 2>/dev/null || echo 0)
echo "RSS_MB=$RSS_MB"
# Pre-fix the leak drove this to 3,286MB. Node settles well under 1.5GB.
(( RSS_MB > 2000 )) && ALERTS+=("rss_high_${RSS_MB}mb")

# ── Minecraft server ───────────────────────────────────────────────────────
if pgrep -f "paper.jar" >/dev/null; then
  echo "SERVER=up"
else
  echo "SERVER=down"
  ALERTS+=("minecraft_server_down")
fi

# ── Sockets (leak regression guard) ────────────────────────────────────────
SOCKETS=$(ls -l "/proc/$WORKER/fd" 2>/dev/null | grep -c socket)
MS_SOCKETS=$(ss -tanp 2>/dev/null | grep "pid=$WORKER" | grep -cE '150\.171\.')
MC_SOCKETS=$(ss -tanp 2>/dev/null | grep "pid=$WORKER" | grep -c 25565)

echo "SOCKETS=$SOCKETS"
echo "MS_SOCKETS=$MS_SOCKETS"
echo "BOTS_CONNECTED=$MC_SOCKETS"

# One shared TTS connection is correct. Anything more means close() regressed.
(( MS_SOCKETS > 2 )) && ALERTS+=("tts_socket_leak_${MS_SOCKETS}")
(( SOCKETS > 200 )) && ALERTS+=("socket_count_high_${SOCKETS}")
(( MC_SOCKETS < 5 )) && ALERTS+=("bots_disconnected_${MC_SOCKETS}_of_5")

# ── Log-derived activity ───────────────────────────────────────────────────
# The worker's stdout is redirected to a task output file; read it off fd 1
# rather than guessing the path.
LOG=$(readlink "/proc/$WORKER/fd/1" 2>/dev/null)

if [[ -n "$LOG" && -r "$LOG" ]]; then
  # grep -c prints 0 AND exits 1 on no matches, so `|| echo 0` would emit two
  # lines and break the arithmetic below. Default the empty case instead.
  count() {
    local n
    n=$(grep -c "$1" "$LOG" 2>/dev/null | head -1)
    echo "${n:-0}"
  }

  CYCLES=$(count 'Brain\] Result:')
  IDLE=$(count 'Just vibing')
  TIMEOUTS=$(count 'UND_ERR_CONNECT_TIMEOUT')
  TTS_ERR=$(count '\[TTS\] Error')

  echo "CYCLES=$CYCLES"
  echo "IDLE=$IDLE"
  echo "TIMEOUTS=$TIMEOUTS"
  echo "TTS_ERRORS=$TTS_ERR"
  echo "LOG_MB=$(( $(stat -c%s "$LOG") / 1048576 ))"

  if (( CYCLES > 20 )); then
    IDLE_PCT=$(( IDLE * 100 / CYCLES ))
    echo "IDLE_PCT=$IDLE_PCT"
    # Healthy measured at 7%. Sustained 50%+ means the brain is falling back.
    (( IDLE_PCT > 50 )) && ALERTS+=("idle_rate_${IDLE_PCT}pct")
  fi

  (( TIMEOUTS > 10 )) && ALERTS+=("llm_timeouts_${TIMEOUTS}")
  (( TTS_ERR > 50 )) && ALERTS+=("tts_errors_${TTS_ERR}")

  # Top actions, for the digest.
  echo -n "TOP_ACTIONS="
  grep -oE '"action":"[a-z_]+"' "$LOG" 2>/dev/null \
    | sed 's/.*:"//;s/"//' | sort | uniq -c | sort -rn | head -5 \
    | awk '{printf "%s:%s ", $2, $1}'
  echo ""
else
  echo "CYCLES=unavailable"
fi

# ── Session stats ──────────────────────────────────────────────────────────
SESSION=$(ls -t logs/sessions/*.json 2>/dev/null | head -1)
if [[ -n "$SESSION" ]]; then
  echo "SESSION=$(basename "$SESSION" .json)"
  # Sum deaths and deposits across bots without needing jq.
  STATS=$(python3 - "$SESSION" <<'PY' 2>/dev/null || true
import json, sys
d = json.load(open(sys.argv[1]))
bots = d.get("perBot", {})
tot = lambda k: sum(b.get(k, 0) for b in bots.values())
acts, succ = tot("actions"), tot("successes")
print(f"DEATHS={tot('deaths')}")
print(f"DEPOSITS={tot('deposits')}")
print(f"ITEMS_DEPOSITED={tot('itemsDeposited')}")
print(f"ACTION_SUCCESS_PCT={round(succ * 100 / acts) if acts else 0}")
print(f"SESSION_ACTIONS={acts}")
worst = max(bots.items(), key=lambda kv: kv[1].get("deaths", 0), default=None)
if worst and worst[1].get("deaths", 0):
    print(f"MOST_DEATHS={worst[0]}:{worst[1]['deaths']}")
print(f"MILESTONES={len(d.get('milestones', []))}")
PY
)
  echo "$STATS"

  # A swarm that only withdraws drains its own stash. deposit_stash bounced 66
  # times in a 5h session with zero successful deposits because auto-expansion
  # required carried planks while bots carry logs (fixed 1cdbb15). Alert if the
  # session has done real work and still banked nothing.
  DEPOSITS=$(sed -n 's/^DEPOSITS=//p' <<<"$STATS")
  SESSION_ACTIONS=$(sed -n 's/^SESSION_ACTIONS=//p' <<<"$STATS")
  if [[ -n "${DEPOSITS:-}" && -n "${SESSION_ACTIONS:-}" ]]; then
    (( SESSION_ACTIONS > 2000 && DEPOSITS == 0 )) && ALERTS+=("no_deposits_in_${SESSION_ACTIONS}_actions")
  fi

  # Fall damage was the top death cause; capped at every Movements site in
  # 2db72c2. A single bot running away with the death count means it regressed.
  DEATHS=$(sed -n 's/^DEATHS=//p' <<<"$STATS")
  if [[ -n "${DEATHS:-}" && -n "${SESSION_ACTIONS:-}" ]]; then
    (( SESSION_ACTIONS > 2000 && DEATHS > 60 )) && ALERTS+=("deaths_high_${DEATHS}")
  fi

  # RATE, not total. Cumulative counters cannot see a stall: deposits sat at 9
  # for a full hour while the stash filled and expansion silently broke, and the
  # zero-deposits alert stayed quiet because 9 is not 0. Compare against the
  # previous run so a swarm that STOPS banking is caught even after a good start.
  STATE_FILE="${TMPDIR:-/tmp}/swarm-health-prev.txt"
  PREV_SESSION=""; PREV_DEPOSITS=""; PREV_DEATHS=""; PREV_ACTIONS=""
  [[ -r "$STATE_FILE" ]] && source "$STATE_FILE"

  SESSION_ID=$(basename "$SESSION" .json)
  if [[ "$PREV_SESSION" == "$SESSION_ID" && -n "$PREV_DEPOSITS" && -n "$PREV_ACTIONS" ]]; then
    ACTION_DELTA=$(( SESSION_ACTIONS - PREV_ACTIONS ))
    DEPOSIT_DELTA=$(( DEPOSITS - PREV_DEPOSITS ))
    DEATH_DELTA=$(( DEATHS - PREV_DEATHS ))
    echo "DELTA_ACTIONS=$ACTION_DELTA DELTA_DEPOSITS=$DEPOSIT_DELTA DELTA_DEATHS=$DEATH_DELTA"

    # Real work happened but nothing was banked: the economy is stalled.
    (( ACTION_DELTA > 400 && DEPOSIT_DELTA == 0 )) && ALERTS+=("deposits_stalled_0_in_${ACTION_DELTA}_actions")
    # Deaths outpacing deposits badly means the swarm is losing ground.
    #
    # This was an AND of both conditions and stayed silent through 13 deaths in
    # one hour, the worst rate of the run, because 13 was not greater than
    # 6 deposits x 3. Requiring a spike to be BOTH large and lopsided means a
    # large-but-not-lopsided spike reports healthy. Either signal alone is worth
    # a look, so they are now independent.
    (( DEATH_DELTA > 10 )) && ALERTS+=("death_spike_${DEATH_DELTA}_since_last")
    (( DEATH_DELTA > 4 && DEPOSIT_DELTA > 0 && DEATH_DELTA > DEPOSIT_DELTA * 3 )) &&
      ALERTS+=("deaths_outpacing_deposits_${DEATH_DELTA}v${DEPOSIT_DELTA}")
  fi

  cat > "$STATE_FILE" <<STATE
PREV_SESSION="$SESSION_ID"
PREV_DEPOSITS="$DEPOSITS"
PREV_DEATHS="$DEATHS"
PREV_ACTIONS="$SESSION_ACTIONS"
STATE
fi

# ── Verdict ────────────────────────────────────────────────────────────────
if (( ${#ALERTS[@]} )); then
  echo "ALERTS=$(IFS=,; echo "${ALERTS[*]}")"
  exit 1
fi

echo "ALERTS=none"
exit 0
