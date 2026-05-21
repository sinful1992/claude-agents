import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readAllSessions, ProjectGroup } from './sessionReader';
import { readCustomizations, Customizations } from './customizationsReader';
import { AgentManager } from './agentManager';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _agentManager: AgentManager,
    private readonly _startAgent: (workspacePath?: string) => void,
    private readonly _resumeSession: (sessionId: string, workspacePath: string) => void,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);font-size:12px;opacity:0.5">Opening Claude Agents…</body></html>`;

    // Open the main panel immediately and on every subsequent click of the icon
    this._startAgent();
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this._startAgent();
    });
  }

  async refresh() {
    await this._sendData();
  }

  pushAgents() {
    if (!this._view) return;
    this._view.webview.postMessage({ type: 'agents', agents: this._agentManager.getAllSummaries() });
  }

  private async _sendData() {
    if (!this._view) return;
    const [groups, customizations] = await Promise.all([
      readAllSessions(),
      readCustomizations(),
    ]);
    this.pushAgents();
    this._view.webview.postMessage({ type: 'sessions', groups, customizations });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="section-header">ACTIVE</div>
  <div id="agents-list" class="agents-list">
    <div class="empty-state">No active agents.</div>
  </div>

  <div class="section-header collapsible" id="sessions-toggle">
    SESSIONS <span class="chevron" id="sessions-chevron">⌄</span>
  </div>
  <div id="sessions-list" class="session-list"></div>

  <div class="customizations-section">
    <div class="customizations-header collapsible" id="customizations-toggle">
      <span>Customizations</span>
      <span class="chevron" id="customizations-chevron">›</span>
    </div>
    <div id="customizations-body" class="customizations-body" style="display:none"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
