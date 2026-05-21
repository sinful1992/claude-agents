import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { SidebarProvider } from './sidebarProvider';
import { AgentManager } from './agentManager';
import { readAllSessions, getProjectsDir } from './sessionReader';
import { readCustomizations } from './customizationsReader';
import { LaunchPanel } from './launchPanel';

let claudePath: string | undefined;

function findClaudePath(): string | undefined {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  try {
    const found = execSync('which claude', { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch { /* fall through */ }
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* try next */ }
  }
  return undefined;
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: NodeJS.Timeout;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

async function openLaunchPanel(
  extensionUri: vscode.Uri,
  agentManager: AgentManager,
  workspacePath?: string
) {
  const launch = async (cwd: string | undefined, model: string, description: string, editAuto: boolean) => {
    if (!claudePath) {
      vscode.window.showErrorMessage('Claude CLI not found. Install it and reload VS Code.');
      return;
    }
    vscode.window.setStatusBarMessage('$(sync~spin) Launching agent…', 4000);
    await agentManager.spawn(description, model, cwd, claudePath, editAuto);
    LaunchPanel.currentPanel?.pushAgents(agentManager.getAllSummaries());
  };

  const attachAgent = (id: string) => {
    if (!claudePath) {
      vscode.window.showErrorMessage('Claude CLI not found. Install it and reload VS Code.');
      return;
    }
    agentManager.attach(id, claudePath);
  };

  const sendInput = (id: string, text: string) => {
    agentManager.sendInput(id, text);
  };

  const stopAgent = (id: string) => {
    agentManager.stopAgent(id);
  };

  const approveAgent = (id: string) => {
    agentManager.approveAgent(id);
  };

  const resumeSession = (sessionId: string, wp: string) => {
    if (!claudePath) {
      vscode.window.showErrorMessage('Claude CLI not found. Install it and reload VS Code.');
      return;
    }
    agentManager.resume(sessionId, wp, claudePath);
  };

  const onReady = async () => {
    LaunchPanel.currentPanel?.pushAgents(agentManager.getAllSummaries());
    const [groups, customizations] = await Promise.all([readAllSessions(), readCustomizations()]);
    LaunchPanel.currentPanel?.pushSessions(groups, customizations);
    const wp = workspacePath
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ?? groups[0]?.workspacePath;
    if (wp) LaunchPanel.currentPanel?.pushFileRoot(wp);
  };

  if (LaunchPanel.currentPanel) {
    if (workspacePath !== undefined) {
      const displayName = path.basename(workspacePath) || '~';
      LaunchPanel.currentPanel['_panel']?.webview?.postMessage({
        type: 'setWorkspace', workspacePath, displayName,
      });
    }
    LaunchPanel.currentPanel['_panel']?.reveal(vscode.ViewColumn.Active);
    LaunchPanel.currentPanel.pushAgents(agentManager.getAllSummaries());
    return;
  }

  const [groups, customizations] = await Promise.all([readAllSessions(), readCustomizations()]);

  LaunchPanel.createOrShow(
    extensionUri, groups, customizations,
    workspacePath, launch, attachAgent, resumeSession, onReady, sendInput, stopAgent, approveAgent
  );
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Claude Agents');
  context.subscriptions.push(output);

  try {
    claudePath = findClaudePath();
    output.appendLine(`Claude path: ${claudePath ?? 'not found'}`);
    if (!claudePath) {
      vscode.window.showWarningMessage(
        'Claude CLI not found in PATH. Install it and reload VS Code.'
      );
    }
    _activate(context, output);
  } catch (err) {
    output.appendLine(`Activation error: ${err}`);
    output.show();
    vscode.window.showErrorMessage(`Claude Agents failed to activate: ${err}`);
  }
}

function _activate(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  const agentManager = new AgentManager(() => {
    sidebarProvider.pushAgents();
    LaunchPanel.currentPanel?.pushAgents(agentManager.getAllSummaries());
  });
  context.subscriptions.push(agentManager);

  // Start background polling as soon as claude is found
  if (claudePath) {
    agentManager.startPolling(claudePath);
    output.appendLine('Agent polling started');
  }

  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    agentManager,
    (wp) => openLaunchPanel(context.extensionUri, agentManager, wp),
    (sessionId, workspacePath) => {
      if (!claudePath) {
        vscode.window.showErrorMessage('Claude CLI not found. Install it and reload VS Code.');
        return;
      }
      agentManager.resume(sessionId, workspacePath, claudePath);
    },
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'claudeAgents.sidebar',
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgents.newSession', () =>
      openLaunchPanel(context.extensionUri, agentManager)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgents.refresh', () =>
      sidebarProvider.refresh()
    )
  );

  // File watching for session history refresh
  const projectsDir = getProjectsDir();
  const subdirWatchers = new Map<string, fs.FSWatcher>();
  const debouncedRefresh = debounce(() => sidebarProvider.refresh(), 500);

  function addSubdirWatcher(dirPath: string) {
    if (subdirWatchers.has(dirPath)) return;
    try {
      const w = fs.watch(dirPath, () => debouncedRefresh());
      subdirWatchers.set(dirPath, w);
      context.subscriptions.push({ dispose: () => w.close() });
    } catch { /* dir may be gone */ }
  }

  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) addSubdirWatcher(path.join(projectsDir, entry.name));
    }
  } catch { /* no projects dir yet */ }

  try {
    const topWatcher = fs.watch(projectsDir, (_event, filename) => {
      if (!filename) return;
      const newDir = path.join(projectsDir, filename);
      fs.stat(newDir, (err, stat) => {
        if (!err && stat.isDirectory()) addSubdirWatcher(newDir);
      });
      debouncedRefresh();
    });
    context.subscriptions.push({ dispose: () => topWatcher.close() });
  } catch { /* no projects dir yet */ }
}

export function deactivate() {}
