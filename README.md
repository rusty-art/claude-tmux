# claude-tmux

A tmux wrapper for Claude Code that provides persistent sessions surviving terminal disconnections.

## Problem

When using Claude Code in VS Code's integrated terminal (especially with WSL), terminal disconnections are common:
- WSL connection drops (Windows / VS Code timeout)
- SSH session times out
- Accidentally closing the terminal
- VS Code crashes or reloads

Without protection, these disconnections **kill your Claude Code process mid-task**. Even though Claude has `--resume` and `--continue` to restore conversation history, you lose:
- **In-flight work**: If Claude was mid-edit or running a command, that's interrupted
- **Live context**: Claude's working memory and any background processes
- **Scroll history**: The terminal output from the session

## Solution

This wrapper runs Claude Code inside tmux sessions. When your terminal disconnects:
- The tmux session **keeps running in the background**
- Claude Code **continues working** on your task uninterrupted
- You reconnect to the **live session**, not a restored conversation

This is different from `claude --resume`:
| | `claude --resume` | This wrapper |
|---|---|---|
| **What it preserves** | Conversation history | Live running process |
| **After disconnect** | Process dies, restore later | Process keeps running |
| **Mid-task interruption** | Work is lost | Work continues |
| **Reconnect to** | New process with old messages | Same running session |

Additionally, the wrapper:
- Organizes sessions by workspace directory
- Shows which sessions are active vs disconnected
- Provides easy session management (list, connect, kill)

## Installation

1. Copy the `claude` script to a directory in your PATH (before the real claude):
   ```bash
   cp claude ~/local/bin/claude
   chmod +x ~/local/bin/claude
   in .bashrc, add "export PATH=$HOME/local/bin:$PATH
   source .bashrc
   hash -r
   ```

2. Ensure the real Claude Code is at `~/.local/bin/claude` (or edit `REAL_CLAUDE` in the script)

3. Install tmux 3.6a or later (required for reliable mouse scrolling and text selection):
   ```bash
   sudo apt install tmux
   tmux -V  # Should show 3.6a or higher
   ```

## Usage

### Interactive Mode

Just run `claude` in any directory:

```
$ claude

╔══════════════════════════════════════════════════════════════╗
║  Claude Code Session Manager                                 ║
╚══════════════════════════════════════════════════════════════╝

Workspace: /home/user/myproject

⚡ DETACHED (can reconnect):
   1) cc-a1b2c3d4-1 [AVAILABLE]

🔒 ATTACHED (in use):
   2) cc-a1b2c3d4-2 [IN USE]

Options:
   [1-9]    Connect to detached session
   [n]      New session
   [k N]    Kill session N
   [q]      Quit
```

### CLI Options

```bash
claude                    # Interactive menu for current workspace
claude --list             # List sessions for current workspace
claude --list-all         # List ALL sessions across all workspaces
claude --connect N        # Connect to session N (from --list-all)
claude --kill N           # Kill session N (from --list-all)
claude --kill-orphans     # Kill all detached sessions
```

### Passing Flags to Claude Code

Flags that don't match wrapper options are passed through to Claude Code:

```bash
claude --resume           # Pass --resume to Claude Code
claude --continue         # Pass --continue to Claude Code
claude -r abc123          # Pass -r abc123 to Claude Code
```

You can also use `--` to explicitly separate wrapper flags from Claude Code flags:

```bash
claude -- --resume        # Equivalent to: claude --resume
```

The `--` separator is only necessary if you need to pass a flag to Claude Code that conflicts with a wrapper flag (e.g., `--list`, `--help`). In practice, you rarely need it since Claude Code's flags don't overlap with the wrapper's.

## tmux Key Bindings

Since Claude Code runs inside tmux, some keyboard shortcuts require the tmux prefix (`Ctrl+B`):

| Keys | Action |
|------|--------|
| `Ctrl+B Ctrl+B` | Send Ctrl+B to Claude (background task) |
| `Ctrl+B Ctrl+Z` | Suspend the tmux client |
| `Ctrl+B d` | Detach from session (keeps Claude running) |
| `Ctrl+B [` | Enter scroll/copy mode (use arrows, `q` to exit) |
| `Ctrl+B PgUp` | Scroll up through history |

### Important Notes

- **Ctrl+B** is tmux's prefix key. Press it, release, then press the next key.
- **Ctrl+B Ctrl+B** sends a literal Ctrl+B through to Claude Code (for backgrounding tasks)
- **Ctrl+C** and **Ctrl+D** work normally (interrupt/exit Claude)
- With `mouse on` in tmux.conf, mouse wheel scrolls through history and text selection works (tmux 3.6a+)

## Session States

| State | Meaning |
|-------|---------|
| `[AVAILABLE]` | Session is running but disconnected - you can reconnect |
| `[IN USE]` | Session is attached to another terminal |

## How It Works

1. Sessions are named `cc-{hash}-{n}` where `{hash}` is derived from the workspace path
2. When you run `claude`, it checks for existing sessions in that workspace
3. If detached sessions exist, it offers to reconnect
4. If all sessions are attached (or none exist), it creates a new one
5. Session state is tracked in `~/.claude-sessions.json`

## Tips

- **Before closing VS Code**: Detach with `Ctrl+B d` to cleanly disconnect
- **After a crash**: Just run `claude` again to see your session as `[AVAILABLE]`
- **Multiple workspaces**: Each directory gets its own session pool
- **Cleanup**: Use `--kill-orphans` to remove abandoned sessions

## Configuration

Edit the script to customize:
- `REAL_CLAUDE`: Path to the actual Claude Code binary
- `SESSION_PREFIX`: Prefix for tmux session names (default: "cc")
- `STATE_FILE`: Location of session state file

### Environment Variables

Set `CLAUDE_TMUX_FLAGS` to pass default flags to every new Claude Code session:

```bash
# In your .bashrc or .zshrc:
export CLAUDE_TMUX_FLAGS="--dangerously-skip-permissions"

# Multiple flags:
export CLAUDE_TMUX_FLAGS="--dangerously-skip-permissions --verbose"
```

These flags are prepended when starting new sessions. Command-line flags (after `--`) are appended after env flags.

## VS Code Integration

If you use VS Code's integrated terminal, configure it to launch tmux automatically. Add to your VS Code `settings.json`:

```json
{
    "terminal.integrated.profiles.linux": {
        "tmux": {
            "path": "bash",
            "args": ["-c", "tmux new -ADs ${PWD##*/}"],
            "icon": "terminal-tmux"
        }
    },
    "terminal.integrated.defaultProfile.linux": "tmux",
    "terminal.integrated.scrollback": 0,
    "terminal.integrated.mouseWheelScrollSensitivity": 1
}
```

What this does:
- **`tmux new -ADs ${PWD##*/}`** — Creates or attaches to a tmux session named after the current folder. `-A` reuses existing sessions, `-D` detaches other clients, `-s` sets the session name.
- **`scrollback: 0`** — Disables VS Code's own scroll buffer. With no buffer to scroll, mouse wheel events get forwarded to tmux instead. This lets tmux's `mouse on` handle scrolling (entering copy-mode on wheel-up, etc.).
- **`mouseWheelScrollSensitivity: 1`** — Keeps mouse wheel speed normal for the terminal. These settings only affect terminal panels, not editor windows.

The wrapper automatically detects when it's already running inside tmux (via the `$TMUX` environment variable) and runs Claude directly without creating a nested session. Management commands like `--list` and `--kill` still work.

## tmux Configuration

Add these to your `~/.tmux.conf`:

```bash
set -g history-limit 50000   # Large scrollback for long Claude sessions
set -g mouse on              # Mouse wheel scrolls through tmux history
```

### Scrolling Through History

| Method | How | Use for |
|--------|-----|---------|
| Mouse wheel | Just scroll | Scrolls through tmux history (with `mouse on`) |
| `Ctrl+B [` | Enter copy mode, PgUp/PgDn to scroll, `q` to exit | Full tmux history (including before reattach) |
| `Ctrl+B PgUp` | Quick scroll up | Shortcut to enter copy mode and scroll |

### tmux Version Requirement

**tmux 3.6a or later is required** for reliable mouse handling. With 3.6a+:
- Mouse scrolling enters tmux copy-mode automatically
- Text selection and copy/paste work normally
- Use `Ctrl+B [` + PgUp/PgDn to access history from before you attached

Earlier tmux versions have issues where mouse events interfere with terminal scrolling and text selection.
