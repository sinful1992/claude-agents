import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';

const execAsync = promisify(childProcess.exec);

export type AgentStatus = 'running' | 'blocked' | 'completed' | 'error';

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  model: string;
  workspacePath: string | undefined;
  startedAt: number;
  status: AgentStatus;
  output: string[];
  pendingApproval?: { toolName: string; preview: string[] };
  diffStats?: { added: number; removed: number };
}

interface PendingApproval {
  toolUseId: string;
  toolName: string;
  preview: string[];
}

interface LiveAgent {
  proc: childProcess.ChildProcess;
  sessionId: string | undefined;
  status: AgentStatus;
  outputLines: string[];
  description: string;
  model: string;
  workspacePath: string | undefined;
  startedAt: number;
  lineBuffer: string;
  pendingApproval: PendingApproval | undefined;
  diffStats: { added: number; removed: number } | undefined;
  // tool_use blocks from assistant messages, keyed by tool_use id
  pendingToolUses: Map<string, { name: string; input: Record<string, unknown> }>;
}

const MAX_OUTPUT = 400;

function userMsg(text: string, sessionId = ''): string {
  return JSON.stringify({
    type: 'user',
    session_id: sessionId,
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  }) + '\n';
}

function buildToolPreview(toolName: string, input: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (input['command']) {
    const cmd = String(input['command']);
    const cmdLines = cmd.split('\n').filter(l => l.trim()).slice(0, 3);
    for (const l of cmdLines) lines.push(l.slice(0, 100));
  } else if (input['file_path']) {
    lines.push(String(input['file_path']));
  } else if (input['query']) {
    lines.push(String(input['query']));
  } else if (input['url']) {
    lines.push(String(input['url']));
  } else if (input['path']) {
    lines.push(String(input['path']));
  } else {
    const firstKey = Object.keys(input)[0];
    if (firstKey) lines.push(String(input[firstKey]).slice(0, 100));
  }
  return lines.slice(0, 3);
}

export class AgentManager {
  private _agents = new Map<string, LiveAgent>();
  private _onChange: () => void;
  private _disposables: vscode.Disposable[] = [];

  constructor(onChange: () => void) {
    this._onChange = onChange;
  }

  startPolling(_claudePath: string) {}

  async spawn(
    description: string,
    model: string,
    workspacePath: string | undefined,
    claudePath: string,
    editAuto = false
  ): Promise<void> {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
      '--input-format', 'stream-json',
      '--model', model,
    ];
    if (workspacePath) args.push('--cwd', workspacePath);
    if (editAuto) args.push('--dangerously-skip-permissions');

    const proc = childProcess.spawn(claudePath, args, {
      cwd: workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const tempId = crypto.randomUUID();
    const agent: LiveAgent = {
      proc,
      sessionId: undefined,
      status: 'running',
      outputLines: [],
      description,
      model,
      workspacePath,
      startedAt: Date.now(),
      lineBuffer: '',
      pendingApproval: undefined,
      diffStats: undefined,
      pendingToolUses: new Map(),
    };
    this._agents.set(tempId, agent);

    proc.stdin?.write(userMsg(description));

    proc.stdout?.on('data', (chunk: Buffer) => {
      agent.lineBuffer += chunk.toString();
      const lines = agent.lineBuffer.split('\n');
      agent.lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this._handleLine(tempId, agent, line);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        this._push(agent, '\x1b[2m[err] ' + text + '\x1b[0m');
        this._onChange();
      }
    });

    proc.on('close', (code) => {
      if (agent.status === 'running' || agent.status === 'blocked') {
        agent.status = code === 0 ? 'completed' : 'error';
        this._onChange();
      }
    });

    proc.on('error', () => {
      agent.status = 'error';
      this._onChange();
    });

    this._onChange();
  }

  private _push(agent: LiveAgent, line: string) {
    agent.outputLines.push(line);
    if (agent.outputLines.length > MAX_OUTPUT) agent.outputLines.shift();
  }

  private _handleLine(_tempId: string, agent: LiveAgent, raw: string) {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(raw); } catch {
      this._push(agent, raw);
      this._onChange();
      return;
    }

    const type = ev['type'] as string | undefined;

    if (type === 'system') {
      if (ev['subtype'] === 'init') {
        agent.sessionId = ev['session_id'] as string | undefined;
      }
      return;
    }

    if (type === 'assistant') {
      const msg = ev['message'] as { content?: unknown[] } | undefined;
      for (const block of (msg?.content ?? []) as Record<string, unknown>[]) {
        if (block['type'] === 'text') {
          const text = block['text'] as string ?? '';
          for (const line of text.split('\n')) this._push(agent, line);
        } else if (block['type'] === 'tool_use') {
          const toolId = block['id'] as string ?? '';
          const toolName = block['name'] as string ?? '';
          const toolInput = (block['input'] as Record<string, unknown>) ?? {};
          if (toolId) agent.pendingToolUses.set(toolId, { name: toolName, input: toolInput });
          this._push(agent, `\x1b[2m⚙ ${toolName}…\x1b[0m`);
        }
      }
      agent.status = 'running';
      this._onChange();
      return;
    }

    if (type === 'tool') {
      const output = ev['output'] as string ?? '';
      if (output) {
        for (const line of output.split('\n').slice(0, 8))
          this._push(agent, '\x1b[2m│ ' + line + '\x1b[0m');
        if (output.split('\n').length > 8) this._push(agent, '\x1b[2m│ …\x1b[0m');
      }
      this._onChange();
      if (agent.workspacePath) this._updateDiffStats(agent);
      return;
    }

    if (type === 'can_use_tool') {
      const req = ev['request'] as Record<string, unknown> ?? {};
      const toolUseId = (req['tool_use_id'] as string) || (ev['tool_use_id'] as string) || '';

      // Prefer tool info stored from the prior assistant message block
      const stored = agent.pendingToolUses.get(toolUseId);
      const toolName = stored?.name
        || (ev['tool_name'] as string)
        || (req['name'] as string)
        || ((req['tool'] as Record<string, unknown>)?.['name'] as string)
        || 'Tool';
      const input: Record<string, unknown> = stored?.input
        || (ev['tool_input'] as Record<string, unknown>)
        || (req['input'] as Record<string, unknown>)
        || ((req['tool'] as Record<string, unknown>)?.['input'] as Record<string, unknown>)
        || {};

      agent.pendingApproval = { toolUseId, toolName, preview: buildToolPreview(toolName, input) };
      agent.status = 'blocked';
      this._onChange();
      return;
    }

    if (type === 'result') {
      agent.status = (ev['is_error'] || ev['subtype'] === 'error_during_execution') ? 'error' : 'completed';
      this._push(agent, '');
      this._push(agent, agent.status === 'completed' ? '─── done ───' : '─── error ───');
      this._onChange();
      return;
    }
  }

  private async _updateDiffStats(agent: LiveAgent): Promise<void> {
    if (!agent.workspacePath) return;
    try {
      const { stdout } = await execAsync('git diff HEAD --shortstat', { cwd: agent.workspacePath });
      const addedMatch = stdout.match(/(\d+) insertion/);
      const removedMatch = stdout.match(/(\d+) deletion/);
      if (addedMatch || removedMatch) {
        agent.diffStats = {
          added: addedMatch ? parseInt(addedMatch[1]) : 0,
          removed: removedMatch ? parseInt(removedMatch[1]) : 0,
        };
        this._onChange();
      }
    } catch { /* not a git repo or no uncommitted changes */ }
  }

  approveAgent(id: string) {
    const agent = this._findById(id);
    if (!agent?.pendingApproval) return;
    const resp = JSON.stringify({ type: 'tool_result', tool_use_id: agent.pendingApproval.toolUseId, behavior: 'allow' }) + '\n';
    agent.proc.stdin?.write(resp);
    agent.pendingToolUses.delete(agent.pendingApproval.toolUseId);
    agent.pendingApproval = undefined;
    agent.status = 'running';
    this._onChange();
  }

  sendInput(id: string, text: string) {
    const agent = this._findById(id);
    if (!agent || agent.status === 'completed' || agent.status === 'error') return;
    agent.proc.stdin?.write(userMsg(text, agent.sessionId ?? ''));
    this._push(agent, '');
    this._push(agent, '> ' + text);
    agent.status = 'running';
    this._onChange();
  }

  stopAgent(id: string) {
    const agent = this._findById(id);
    if (!agent) return;
    try { agent.proc.kill('SIGTERM'); } catch {}
    agent.status = 'completed';
    this._onChange();
  }

  private _findById(id: string): LiveAgent | undefined {
    if (this._agents.has(id)) return this._agents.get(id);
    for (const a of this._agents.values()) {
      if (a.sessionId === id) return a;
    }
    return undefined;
  }

  attach(id: string, claudePath: string) {
    const agent = this._findById(id);
    const sessionId = agent?.sessionId ?? id;
    const terminal = vscode.window.createTerminal({
      name: (agent?.description ?? '').slice(0, 30) || ('Agent ' + id.slice(0, 6)),
      cwd: agent?.workspacePath,
      shellPath: claudePath,
      shellArgs: ['--resume', sessionId],
      location: vscode.TerminalLocation.Editor,
    });
    terminal.show();
  }

  resume(sessionId: string, workspacePath: string | undefined, claudePath: string) {
    const terminal = vscode.window.createTerminal({
      name: 'Session ' + sessionId.slice(0, 8),
      cwd: workspacePath,
      shellPath: claudePath,
      shellArgs: ['--resume', sessionId],
      location: vscode.TerminalLocation.Editor,
    });
    terminal.show();
  }

  getAllSummaries(): AgentSummary[] {
    const results: AgentSummary[] = [];
    for (const [tempId, a] of this._agents) {
      results.push({
        id: a.sessionId ?? tempId,
        name: a.description.slice(0, 60) || 'Agent',
        description: a.description,
        model: a.model,
        workspacePath: a.workspacePath,
        startedAt: a.startedAt,
        status: a.status,
        output: a.outputLines.slice(-60),
        pendingApproval: a.pendingApproval
          ? { toolName: a.pendingApproval.toolName, preview: a.pendingApproval.preview }
          : undefined,
        diffStats: a.diffStats,
      });
    }
    return results.sort((a, b) => b.startedAt - a.startedAt);
  }

  dispose() {
    for (const a of this._agents.values()) {
      try { a.proc.kill(); } catch {}
    }
    for (const d of this._disposables) d.dispose();
  }
}
