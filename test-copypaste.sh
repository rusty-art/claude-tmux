#!/usr/bin/env bash
#
# test-copypaste.sh - Interactive copy/paste test for current tmux config
#
# Tests the current ~/.tmux.conf without modifying it.
# Launches a tmux session with test content and collects pass/fail ratings.
#
# Usage: bash test-copypaste.sh
#

set -euo pipefail

# Colors
RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
CYAN='\033[1;36m'
DIM='\033[90m'
BOLD='\033[1m'
RESET='\033[0m'

SESSION_NAME="cp-test"
RESULTS_FILE="/tmp/copypaste-results-$$.txt"

# Must run OUTSIDE tmux
if [ -n "${TMUX:-}" ]; then
    echo -e "${RED}ERROR: Run this script OUTSIDE of tmux${RESET}"
    echo "Detach first with Ctrl+B d, then run: bash test-copypaste.sh"
    exit 1
fi

for cmd in tmux xclip; do
    if ! command -v "$cmd" &>/dev/null; then
        echo -e "${RED}ERROR: $cmd not found${RESET}"
        exit 1
    fi
done

> "$RESULTS_FILE"

cleanup() {
    tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
    rm -f "/tmp/cp-test-$$.sh"
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Test content - runs INSIDE the tmux session
# ─────────────────────────────────────────────────────────────────────────────
generate_test_content() {
    cat << 'CONTENT'
╔══════════════════════════════════════════════════════════════╗
║                 COPY/PASTE TEST CONTENT                     ║
╚══════════════════════════════════════════════════════════════╝

━━━ TEST 1: Simple text selection ━━━
Select this line: The quick brown fox jumps over the lazy dog

━━━ TEST 2: Multi-line selection ━━━
Line A: First line of multi-line test
Line B: Second line of multi-line test
Line C: Third line of multi-line test

━━━ TEST 3: Code block selection ━━━
    function hello() {
        console.log("Hello, World!");
        return 42;
    }

━━━ TEST 4: URL selection ━━━
https://github.com/tmux/tmux/issues/2283

━━━ TEST 5: Mixed content ━━━
Name: Steve  |  Score: 100  |  Status: Active

━━━ TEST 6: Long line (horizontal scroll test) ━━━
ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz-END

━━━ SCROLL TEST: Lines to create scroll history ━━━
CONTENT

    for i in $(seq 1 60); do
        echo "Scroll line $i: Lorem ipsum dolor sit amet consectetur"
    done

    cat << 'FOOTER'

━━━ TEST 7: Bottom of scroll area ━━━
If you can see this AND scroll up to see TEST 1, scrolling works!

╔══════════════════════════════════════════════════════════════╗
║                   TESTING INSTRUCTIONS                      ║
╚══════════════════════════════════════════════════════════════╝

Try each action:

  1. CLICK-DRAG to select "quick brown fox" (should highlight + auto-copy)
  2. LEFT-CLICK after selection (should dismiss highlight)
  3. RIGHT-CLICK (should paste from Windows clipboard)
  4. SCROLL UP with mouse wheel (should scroll through history)
  5. After scrolling up, LEFT-CLICK (should exit scroll mode)
  6. DOUBLE-CLICK on a word (should select word + copy)
  7. TRIPLE-CLICK on a line (should select line + copy)
  8. Copy text here, then Ctrl+V into Windows Notepad (should work)
  9. Copy text FROM Windows Notepad, then right-click here (should paste)
 10. Check: does paste add a trailing newline? (should NOT)

When done testing, press Ctrl+B d to detach.

FOOTER
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║${RESET}  ${BOLD}TMux Copy/Paste Test${RESET}                                       ${CYAN}║${RESET}"
echo -e "${CYAN}║${RESET}  ${DIM}Testing current ~/.tmux.conf (not modified)${RESET}                 ${CYAN}║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${RESET}"
echo ""

# Show current config summary
echo -e "${BOLD}Current config:${RESET}"
echo -e "${DIM}$(head -5 ~/.tmux.conf 2>/dev/null || echo 'No ~/.tmux.conf found')${RESET}"
echo ""

# Build the inner script
test_script="/tmp/cp-test-$$.sh"
cat > "$test_script" << 'SCRIPT'
#!/usr/bin/env bash
SCRIPT
declare -f generate_test_content >> "$test_script"
cat >> "$test_script" << 'SCRIPT'
generate_test_content
echo ""
echo "Press Enter when done testing (or Ctrl+B d to detach)..."
read -r
SCRIPT
chmod +x "$test_script"

# Kill any leftover test session
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

# Start fresh session (uses current ~/.tmux.conf automatically)
tmux new-session -d -s "$SESSION_NAME" "bash $test_script"

echo -e "${YELLOW}Attaching to tmux session...${RESET}"
echo -e "${DIM}Test the behaviors, then Ctrl+B d to detach${RESET}"
echo ""
sleep 0.3

tmux attach -t "$SESSION_NAME"

# After detach, collect results
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

echo ""
echo -e "${BOLD}Rate each behavior:${RESET}"
echo ""

tests=(
    "Click-drag select + auto-copy"
    "Left-click dismisses selection"
    "Right-click pastes (no trailing newline)"
    "Mouse scroll (up/down)"
    "Left-click exits scroll mode"
    "Double-click selects word"
    "Triple-click selects line"
    "tmux -> Windows Notepad (Ctrl+V)"
    "Windows Notepad -> tmux (right-click)"
    "Ctrl+Shift+V paste"
)
scores=()

for test_item in "${tests[@]}"; do
    while true; do
        echo -ne "  ${test_item}: ${DIM}[P]ass / [F]ail / [S]kip > ${RESET}"
        read -r -n1 score
        echo ""
        case "${score,,}" in
            p) scores+=("PASS"); break;;
            f) scores+=("FAIL"); break;;
            s) scores+=("SKIP"); break;;
            *) echo -e "  ${RED}Invalid. Use P, F, or S${RESET}";;
        esac
    done
done

echo -ne "  ${BOLD}Overall feel (1-5, 5=native): ${RESET}"
read -r overall

# Save results
{
    echo "=== Test Results $(date) ==="
    echo ""
    for i in "${!tests[@]}"; do
        printf "  %-45s %s\n" "${tests[$i]}" "${scores[$i]}"
    done
    echo ""
    echo "  Overall: ${overall}/5"
    echo ""
    pass_count=0
    for s in "${scores[@]}"; do [[ "$s" == "PASS" ]] && ((pass_count++)); done
    echo "  Score: ${pass_count}/${#tests[@]} passed"
} | tee "$RESULTS_FILE"

echo ""
echo -e "${DIM}Results saved to: $RESULTS_FILE${RESET}"
