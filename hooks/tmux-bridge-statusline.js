#!/usr/bin/env node
// tmux-status-hook.js — PostToolUse hook for Claude Code → tmux status
//
// Reads transcript_path for model/tokens, gathers git/task/GSD data,
// updates tmux status-format[1] directly. Also writes bridge files
// for gsd-context-monitor compatibility.
//
// No settings.statusLine needed — native Claude Code statusline preserved.
// No stdout output — purely side-effect based.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DEBOUNCE_SEC = 3;
const BRIDGE_PATH = path.join(os.tmpdir(), 'claude-tmux-status.json');

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, timeout: 2000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return ''; }
}

const MODEL_NAMES = {
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-5': 'Opus 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-haiku-4-5': 'Haiku 4.5',
};

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    if (!process.env.TMUX) process.exit(0);

    const data = JSON.parse(input);
    const session = data.session_id || '';
    const dir = data.cwd || process.cwd();
    const transcriptPath = data.transcript_path;
    const homeDir = os.homedir();
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');

    // Debounce: skip if bridge file written recently
    if (fs.existsSync(BRIDGE_PATH)) {
      try {
        const prev = JSON.parse(fs.readFileSync(BRIDGE_PATH, 'utf8'));
        if (prev.timestamp && (Math.floor(Date.now() / 1000) - prev.timestamp) < DEBOUNCE_SEC) {
          process.exit(0);
        }
      } catch {}
    }

    // ── Read transcript for model and token usage ──
    let modelId = '';
    let modelName = 'Claude';
    let totalInput = 0;
    let totalOutput = 0;
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      try {
        // Read last 20KB for efficiency — enough to find the last assistant entry
        const stat = fs.statSync(transcriptPath);
        const readSize = Math.min(stat.size, 20480);
        const buf = Buffer.alloc(readSize);
        const fd = fs.openSync(transcriptPath, 'r');
        fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
        fs.closeSync(fd);
        const tail = buf.toString('utf8');
        const lines = tail.split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.type === 'assistant' && entry.message?.usage) {
              modelId = entry.message.model || '';
              const u = entry.message.usage;
              totalInput = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
              totalOutput = u.output_tokens || 0;
              break;
            }
          } catch {}
        }
      } catch {}
    }

    // Map model ID to display name
    const baseModelId = modelId.replace(/\[.*\]$/, '');
    modelName = MODEL_NAMES[baseModelId] || baseModelId || 'Claude';
    if (modelId.includes('[1m]')) modelName += ' 1M';

    // ── Context window estimation ──
    const MODEL_CONTEXTS = { 'claude-opus-4-6': 1000000, 'claude-opus-4-5': 200000, 'claude-sonnet-4-6': 200000, 'claude-sonnet-4-5': 200000, 'claude-haiku-4-5': 200000 };
    let maxContext = MODEL_CONTEXTS[baseModelId] || 200000;
    if (modelId.includes('[1m]')) maxContext = 1000000;
    const usedPct = totalInput > 0 ? Math.min(100, Math.round((totalInput / maxContext) * 100)) : null;
    const remainingPct = usedPct != null ? Math.max(0, 100 - usedPct) : null;

    // ── Current task from todos ──
    let task = '';
    let taskCount = 0;
    const todosDir = path.join(claudeDir, 'todos');
    if (session && fs.existsSync(todosDir)) {
      try {
        const files = fs.readdirSync(todosDir)
          .filter(f => f.startsWith(session) && f.includes('-agent-') && f.endsWith('.json'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].name), 'utf8'));
          const inProgress = todos.find(t => t.status === 'in_progress');
          if (inProgress) task = inProgress.activeForm || '';
          taskCount = todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;
        }
      } catch {}
    }

    // ── Git info ──
    let git = null;
    if (run('git', ['rev-parse', '--is-inside-work-tree'], dir) === 'true') {
      git = { modified: 0, staged: 0, untracked: 0, ahead: 0, behind: 0 };
      git.branch = run('git', ['branch', '--show-current'], dir) || run('git', ['rev-parse', '--short', 'HEAD'], dir);
      git.worktree = run('git', ['rev-parse', '--git-dir'], dir).includes('/worktrees/');

      const status = run('git', ['status', '--porcelain'], dir);
      if (status) {
        for (const line of status.split('\n').filter(Boolean)) {
          const x = line[0], y = line[1];
          if (x !== ' ' && x !== '?') git.staged++;
          if (x === '?' && y === '?') git.untracked++;
          else if (y !== ' ') git.modified++;
        }
      }

      const ab = run('git', ['rev-list', '--count', '--left-right', '@{upstream}...HEAD'], dir);
      if (ab && ab.includes('\t')) {
        const [behind, ahead] = ab.split('\t').map(Number);
        git.behind = behind;
        git.ahead = ahead;
      }
    }

    // ── GSD update check ──
    let gsdUpdate = false, gsdStaleHooks = false;
    const cacheFile = path.join(claudeDir, 'cache', 'gsd-update-check.json');
    if (fs.existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        gsdUpdate = !!cache.update_available;
        gsdStaleHooks = !!(cache.stale_hooks && cache.stale_hooks.length > 0);
      } catch {}
    }

    // ── System resources ──
    const cpuPct = Math.round((os.loadavg()[0] / os.cpus().length) * 100);
    const ramPct = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);

    // ── Write context bridge file (for gsd-context-monitor) ──
    if (session && remainingPct != null) {
      try {
        fs.writeFileSync(
          path.join(os.tmpdir(), `claude-ctx-${session}.json`),
          JSON.stringify({ session_id: session, remaining_percentage: remainingPct, used_pct: usedPct, timestamp: Math.floor(Date.now() / 1000) })
        );
      } catch {}
    }

    // ── Write comprehensive bridge file ──
    const bridge = {
      model: modelName, model_id: modelId, dir: path.basename(dir), session_id: session,
      context: usedPct != null ? { used_pct: usedPct, remaining_pct: remainingPct, tokens: totalInput, max_context: maxContext } : null,
      task, task_count: taskCount, git,
      gsd: { update_available: gsdUpdate, stale_hooks: gsdStaleHooks },
      system: { cpu_pct: cpuPct, ram_pct: ramPct },
      timestamp: Math.floor(Date.now() / 1000)
    };
    try { fs.writeFileSync(BRIDGE_PATH, JSON.stringify(bridge)); } catch {}

    // ── Update tmux status-format[1] ──
    const p = [];

    // GSD alerts
    if (gsdUpdate) p.push('#[fg=yellow]\u2b06 update#[fg=default]');
    if (gsdStaleHooks) p.push('#[fg=red]\u26a0 hooks#[fg=default]');

    // Model
    p.push(`#[dim]${modelName}#[nodim]`);

    // Current task
    if (task) p.push(`#[bold]${task}#[nobold]`);

    // Directory
    p.push(`#[dim]${bridge.dir}#[nodim]`);

    // Git
    if (git) {
      const gp = [];
      if (git.branch) {
        const prefix = git.worktree ? '\u2387' + git.branch + ' (wt)' : '\u2387' + git.branch;
        gp.push(`#[fg=cyan]${prefix}#[fg=default]`);
      }
      if (git.modified > 0) gp.push(`#[fg=red]M:${git.modified}#[fg=default]`);
      if (git.staged > 0) gp.push(`#[fg=green]S:${git.staged}#[fg=default]`);
      if (git.untracked > 0) gp.push(`#[dim]?:${git.untracked}#[nodim]`);
      if (git.ahead > 0) gp.push(`#[fg=green]\u2191${git.ahead}#[fg=default]`);
      if (git.behind > 0) gp.push(`#[fg=red]\u2193${git.behind}#[fg=default]`);
      if (gp.length) p.push(gp.join(' '));
    }

    // System
    const cpuCol = cpuPct > 80 ? 'red' : cpuPct > 50 ? 'yellow' : 'default';
    const ramCol = ramPct > 80 ? 'red' : ramPct > 50 ? 'yellow' : 'default';
    p.push(`#[fg=${cpuCol}]CPU:${cpuPct}%#[fg=default] #[fg=${ramCol}]RAM:${ramPct}%#[fg=default]`);

    // Tasks
    if (taskCount > 0) p.push(`#[fg=yellow]Tasks:${taskCount}#[fg=default]`);

    // Context bar
    if (usedPct != null) {
      const filled = Math.floor(usedPct / 10);
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
      const tokenK = Math.round(totalInput / 1000);
      const maxK = Math.round(maxContext / 1000);
      let col = 'green';
      if (usedPct >= 80) col = 'red';
      else if (usedPct >= 65) col = 'colour208';
      else if (usedPct >= 50) col = 'yellow';
      const attr = usedPct >= 80 ? ',blink' : '';
      const skull = usedPct >= 80 ? '\ud83d\udc80 ' : '';
      p.push(`#[fg=${col}${attr}]${skull}${bar} ${usedPct}% ${tokenK}K/${maxK}K#[fg=default,noblink]`);
    }

    const line = ' ' + p.join(' \u2502 ') + ' ';
    execFileSync('tmux', ['set-option', '-gq', 'status-format[1]', line], { timeout: 1000, stdio: 'pipe' });

  } catch {
    process.exit(0);
  }
});
