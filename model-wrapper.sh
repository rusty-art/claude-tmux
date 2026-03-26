#!/usr/bin/env bash
REAL="${0}.real"
args=()
is_agent=false
for a in "$@"; do [[ "$a" == "--agent-id" ]] && is_agent=true; done
next_is_model=false
for a in "$@"; do
    if $next_is_model; then
        if $is_agent && [[ "$a" == "claude-opus-4-6" ]]; then
            args+=("claude-opus-4-6[1m]")
        else
            args+=("$a")
        fi
        next_is_model=false
        continue
    fi
    [[ "$a" == "--model" ]] && next_is_model=true
    args+=("$a")
done
exec -a "$0" "$REAL" "${args[@]}"
