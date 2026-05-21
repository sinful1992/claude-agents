import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectGroup } from './sessionReader';
import { Customizations } from './customizationsReader';
import { AgentSummary } from './agentManager';

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

async function readDirEntries(dirPath: string): Promise<FileEntry[]> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name), isDir: e.isDirectory() }));
  } catch {
    return [];
  }
}

export class LaunchPanel {
  public static currentPanel: LaunchPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private _groups: ProjectGroup[],
    private _customizations: Customizations,
    private _workspacePath: string | undefined,
    private readonly _launch: (workspacePath: string | undefined, model: string, description: string, editAuto: boolean) => void,
    private readonly _attachAgent: (id: string) => void,
    private readonly _resumeSession: (sessionId: string, workspacePath: string) => void,
    private readonly _onReady: () => void,
    private readonly _sendInput: (id: string, text: string) => void,
    private readonly _stopAgent: (id: string) => void,
    private readonly _approveAgent: (id: string) => void,
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Move panel to its own window on first open.
    // onDidChangeViewState may not fire if the panel starts already active,
    // so also use a 500ms fallback timer.
    let moved = false;
    const doMove = () => {
      if (moved) return;
      moved = true;
      vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    };
    this._panel.onDidChangeViewState(() => doMove(), null, this._disposables);
    const moveTimer = setTimeout(doMove, 500);
    this._disposables.push({ dispose: () => clearTimeout(moveTimer) });

    this._update();

    this._panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'launch') {
        this._launch(msg.workspacePath || undefined, msg.model, msg.description, !!msg.editAuto);
        this._panel.webview.postMessage({ type: 'launchDone' });
      } else if (msg.type === 'attachAgent') {
        this._attachAgent(msg.id);
      } else if (msg.type === 'sendInput') {
        this._sendInput(msg.id, msg.text);
      } else if (msg.type === 'stopAgent') {
        this._stopAgent(msg.id);
      } else if (msg.type === 'approveAgent') {
        this._approveAgent(msg.id);
      } else if (msg.type === 'resumeSession') {
        this._resumeSession(msg.sessionId, msg.workspacePath);
      } else if (msg.type === 'ready') {
        this._onReady();
      } else if (msg.type === 'getFiles') {
        const items = await readDirEntries(msg.path);
        this._panel.webview.postMessage({ type: 'files', parentPath: msg.path, items });
      } else if (msg.type === 'workspaceChanged') {
        const items = await readDirEntries(msg.workspacePath);
        this._panel.webview.postMessage({ type: 'fileRoot', workspacePath: msg.workspacePath, items });
      }
    }, null, this._disposables);
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    groups: ProjectGroup[],
    customizations: Customizations,
    workspacePath: string | undefined,
    launch: (workspacePath: string | undefined, model: string, description: string, editAuto: boolean) => void,
    attachAgent: (id: string) => void,
    resumeSession: (sessionId: string, workspacePath: string) => void,
    onReady: () => void,
    sendInput: (id: string, text: string) => void,
    stopAgent: (id: string) => void,
    approveAgent: (id: string) => void,
  ) {
    const column = vscode.ViewColumn.Active;

    if (LaunchPanel.currentPanel) {
      if (workspacePath !== undefined) {
        const displayName = path.basename(workspacePath) || '~';
        LaunchPanel.currentPanel._panel.webview.postMessage({
          type: 'setWorkspace',
          workspacePath,
          displayName,
        });
      }
      LaunchPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'claudeAgents.launch',
      'Claude Agents',
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      }
    );

    LaunchPanel.currentPanel = new LaunchPanel(
      panel, extensionUri, groups, customizations,
      workspacePath, launch, attachAgent, resumeSession, onReady, sendInput, stopAgent, approveAgent
    );
  }

  public dispose() {
    LaunchPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }

  public pushAgents(agents: AgentSummary[]) {
    this._panel.webview.postMessage({ type: 'agents', agents });
  }

  public pushSessions(groups: ProjectGroup[], customizations: Customizations) {
    this._panel.webview.postMessage({ type: 'sessions', groups, customizations });
  }

  public async pushFileRoot(workspacePath: string) {
    const items = await readDirEntries(workspacePath);
    this._panel.webview.postMessage({ type: 'fileRoot', workspacePath, items });
  }

  private _update() {
    const webview = this._panel.webview;
    const nonce = crypto.randomBytes(16).toString('hex');

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'launch.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'launch.css')
    );

    const workspacePaths = this._groups.map(g => ({
      path: g.workspacePath,
      displayName: g.displayName,
    }));

    const selectedWorkspace = this._workspacePath
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ?? workspacePaths[0]?.path;

    const selectedDisplayName = selectedWorkspace
      ? (path.basename(selectedWorkspace) || '~')
      : 'workspace';

    const initData = JSON.stringify({
      workspacePaths,
      selectedWorkspace,
      selectedDisplayName,
      groups: this._groups,
      customizations: this._customizations,
    });

    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="agents-window">

    <!-- Left: Sessions + Customizations -->
    <div class="sessions-col">
      <div class="sessions-col-header">
        <span class="col-title">Sessions</span>
        <div class="sessions-col-actions">
          <button class="icon-btn" id="new-session-btn" title="New Session (Ctrl+N)">New <kbd>Ctrl+N</kbd></button>
          <button class="icon-btn icon-only" id="refresh-sessions-btn" title="Refresh">⟳</button>
          <button class="icon-btn icon-only" id="search-toggle-btn" title="Search">⌕</button>
        </div>
      </div>
      <div class="sessions-search-wrap" id="search-wrap" style="display:none">
        <input type="text" id="sessions-search" class="sessions-search" placeholder="Filter sessions...">
      </div>
      <div id="sessions-list" class="sessions-list"></div>
      <!-- Customizations at bottom -->
      <div class="customizations-section">
        <div class="customizations-header" id="customizations-toggle">
          <span>Customizations</span>
          <span class="chevron" id="customizations-chevron">›</span>
        </div>
        <div id="customizations-body" class="customizations-body" style="display:none"></div>
      </div>
    </div>

    <!-- Center: Active agents + launch form -->
    <div class="center-col">
      <div class="agents-area" id="agents-area">
        <div class="agents-section-header">
          <span>AGENTS</span>
          <span class="agents-header-hint">running in background · no tabs</span>
        </div>
        <div id="agents-list">
          <div class="agents-empty" id="agents-empty">No active agents. Launch one below — it runs in the background.</div>
        </div>
      </div>
      <div class="launch-form">
        <div class="launch-header">
          <span class="header-label">New session in</span>
          <div class="header-dropdown" id="workspace-dropdown">
            <span class="folder-icon">⊡</span>
            <span id="workspace-label">${escapeHtml(selectedDisplayName)}</span>
            <span class="chevron">⌄</span>
            <div class="dropdown-menu" id="workspace-menu"></div>
          </div>
          <span class="header-label">with</span>
          <div class="header-dropdown" id="model-dropdown">
            <span class="sparkle">✳</span>
            <span id="model-label">Claude</span>
            <span class="chevron">⌄</span>
            <div class="dropdown-menu" id="model-menu"></div>
          </div>
        </div>
        <div class="chat-input-container" id="launch-input-container">
          <div class="chat-editor-container">
            <textarea
              id="prompt-input"
              class="interactive-input-editor"
              placeholder="What will you launch?"
              autofocus
            ></textarea>
          </div>
          <div class="chat-input-toolbars">
            <div class="chat-input-toolbar">
              <div class="model-chip" id="model-chip">
                <span class="plus-icon">+</span>
                <span id="model-chip-label">claude</span>
              </div>
              <label class="edit-auto-chip" title="Run with --dangerously-skip-permissions">
                <input type="checkbox" id="edit-auto-checkbox">
                <span>Edit Automatically</span>
              </label>
            </div>
            <div class="chat-execute-toolbar">
              <button class="submit-btn" id="submit-btn" title="Launch (Ctrl+Enter)">↑</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Right: Changes | Files -->
    <div class="right-col">
      <div class="right-tabs">
        <button class="right-tab" id="tab-changes" data-tab="changes">Changes</button>
        <button class="right-tab active" id="tab-files" data-tab="files">Files</button>
        <div class="right-tab-spacer"></div>
        <button class="icon-btn icon-only" id="files-search-btn" title="Search files">⌕</button>
        <button class="icon-btn icon-only" id="files-expand-btn" title="Expand all">⊞</button>
      </div>
      <div id="panel-changes" class="right-panel" style="display:none">
        <div class="right-empty">No changes yet.</div>
      </div>
      <div id="panel-files" class="right-panel file-tree-panel">
        <div class="right-empty" id="files-empty">Select a workspace to browse files.</div>
        <div id="file-tree" class="file-tree"></div>
      </div>
    </div>

  </div>
  <script nonce="${nonce}">
    window.__INIT__ = ${initData};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
