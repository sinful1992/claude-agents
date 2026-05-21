(function () {
  const vscode = acquireVsCodeApi();
  const init = window.__INIT__;

  let selectedWorkspace = init.selectedWorkspace;
  let selectedModel = 'claude';
  let agents = [];
  let currentGroups = init.groups || [];
  const expandedGroups = new Set();
  const expandedCustomSections = new Set();

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatDuration(startMs) {
    const s = Math.floor((Date.now() - startMs) / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function formatRelativeTime(epochMs) {
    const d = Math.floor((Date.now() - epochMs) / 1000);
    if (d < 60)     { return d + 's ago'; }
    if (d < 3600)   { const m = Math.floor(d/60);    return m + ' min' + (m > 1 ? 's' : '') + ' ago'; }
    if (d < 86400)  { const h = Math.floor(d/3600);  return h + ' hr'  + (h > 1 ? 's' : '') + ' ago'; }
    if (d < 604800) { const dd = Math.floor(d/86400); return dd + ' day' + (dd > 1 ? 's' : '') + ' ago'; }
    const w = Math.floor(d/604800); return w + ' wk' + (w > 1 ? 's' : '') + ' ago';
  }

  function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;?]*[mGKHFJsuhl]/g, '').replace(/\x1b[=>]/g, '');
  }

  // ── Active agents ──────────────────────────────────────

  let expandedAgentId = null;
  let expandedOutputEl = null;
  let expandedRenderedCount = 0;

  // Build the approval row element (hidden by default, shown with .visible)
  function buildApprovalRowEl(agentId) {
    const row = document.createElement('div');
    row.className = 'agent-session-approval-row';

    const label = document.createElement('span');
    label.className = 'agent-session-approval-label';
    row.appendChild(label);

    const btnContainer = document.createElement('div');
    btnContainer.className = 'agent-session-approval-button';
    const allowBtn = document.createElement('button');
    allowBtn.className = 'agent-allow-btn';
    allowBtn.textContent = 'Allow';
    allowBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      vscode.postMessage({ type: 'approveAgent', id: agentId });
    });
    btnContainer.appendChild(allowBtn);
    row.appendChild(btnContainer);

    return row;
  }

  function updateApprovalRowContent(approvalRow, pendingApproval) {
    const label = approvalRow.querySelector('.agent-session-approval-label');
    if (!label) return;
    label.innerHTML = '';
    if (pendingApproval) {
      const toolEl = document.createElement('div');
      toolEl.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:3px;opacity:0.8';
      toolEl.textContent = '⚙ ' + pendingApproval.toolName;
      label.appendChild(toolEl);
      if (pendingApproval.preview && pendingApproval.preview.length > 0) {
        const code = document.createElement('div');
        code.style.cssText = 'font-family:var(--vscode-editor-font-family,monospace);font-size:11px;overflow:hidden';
        for (const line of pendingApproval.preview) {
          const l = document.createElement('div');
          l.style.cssText = 'white-space:pre;overflow:hidden;text-overflow:ellipsis;line-height:1.5';
          l.textContent = line;
          code.appendChild(l);
        }
        label.appendChild(code);
      }
    }
  }

  function renderAgents() {
    const list  = document.getElementById('agents-list');
    const empty = document.getElementById('agents-empty');

    if (!agents || agents.length === 0) {
      list.innerHTML = '';
      list.appendChild(empty);
      empty.style.display = '';
      expandedAgentId = null;
      expandedOutputEl = null;
      expandedRenderedCount = 0;
      return;
    }
    empty.style.display = 'none';

    if (expandedAgentId && expandedOutputEl) {
      const expanded = agents.find(function(a) { return a.id === expandedAgentId; });
      if (expanded) {
        appendNewOutputLines(expanded);
        updateCardBadge(expanded);
        return;
      }
    }

    list.innerHTML = '';
    expandedOutputEl = null;
    expandedRenderedCount = 0;

    const active   = agents.filter(function(a) { return a.status === 'running' || a.status === 'blocked'; });
    const finished = agents.filter(function(a) { return a.status !== 'running' && a.status !== 'blocked'; });

    function renderGroup(label, items) {
      if (items.length === 0) return;
      if (label) {
        const hdr = document.createElement('div');
        hdr.className = 'agent-session-section agents-section-header';
        hdr.style.marginTop = '6px';
        const labelEl = document.createElement('span');
        labelEl.className = 'agent-session-section-label';
        labelEl.textContent = label;
        hdr.appendChild(labelEl);
        list.appendChild(hdr);
      }
      for (const agent of items) list.appendChild(buildAgentCard(agent));
    }

    renderGroup(active.length > 0 ? 'Active' : null, active);
    renderGroup(finished.length > 0 ? 'Recent' : null, finished.slice(0, 5));

    const blockedCount = active.filter(function(a) { return a.status === 'blocked'; }).length;
    document.title = blockedCount > 0 ? '(' + blockedCount + ' waiting) Claude Agents' : 'Claude Agents';
  }

  // Build an agent card using VS Code's exact agent-session-item structure
  function buildAgentCard(agent) {
    const isActive   = agent.status === 'running' || agent.status === 'blocked';
    const isExpanded = agent.id === expandedAgentId;
    const elapsed    = formatDuration(agent.startedAt);
    const workspace  = agent.workspacePath ? agent.workspacePath.split('/').pop() : '—';

    // Outer card wrapper (flex column: session-item row + output + input)
    const card = document.createElement('div');
    card.className = 'agent-card' + (isExpanded ? ' agent-card-expanded' : '');
    card.dataset.agentId = agent.id;

    // ── agent-session-item row (VS Code's exact structure) ──
    const item = document.createElement('div');
    item.className = 'agent-session-item';

    // Icon column
    const iconCol = document.createElement('div');
    iconCol.className = 'agent-session-icon-col';
    const iconEl = document.createElement('div');
    iconEl.className = 'agent-session-icon status-' + agent.status + (isActive ? ' needs-input' : '');
    iconCol.appendChild(iconEl);

    // Main column
    const mainCol = document.createElement('div');
    mainCol.className = 'agent-session-main-col';

    // Title row
    const titleRow = document.createElement('div');
    titleRow.className = 'agent-session-title-row';

    const titleEl = document.createElement('div');
    titleEl.className = 'agent-session-title';
    titleEl.textContent = agent.name;
    titleRow.appendChild(titleEl);

    // Title toolbar (hover-reveal buttons, VS Code style)
    const toolbar = document.createElement('div');
    toolbar.className = 'agent-session-title-toolbar';
    if (isActive) {
      const attachBtn = document.createElement('button');
      attachBtn.className = 'toolbar-btn';
      attachBtn.title = 'Attach in terminal';
      attachBtn.textContent = '↗';
      attachBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'attachAgent', id: agent.id });
      });
      const stopBtn = document.createElement('button');
      stopBtn.className = 'toolbar-btn toolbar-btn-stop';
      stopBtn.title = 'Stop agent';
      stopBtn.textContent = '✕';
      stopBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'stopAgent', id: agent.id });
      });
      toolbar.appendChild(attachBtn);
      toolbar.appendChild(stopBtn);
    }
    titleRow.appendChild(toolbar);

    // Expand toggle (our addition, subtle)
    const toggle = document.createElement('span');
    toggle.className = 'agent-expand-toggle';
    toggle.textContent = isExpanded ? '⌄' : '›';
    titleRow.appendChild(toggle);

    // Details row (VS Code's exact structure)
    const detailsRow = document.createElement('div');
    detailsRow.className = 'agent-session-details-row';

    // Badge (workspace name)
    const badge = document.createElement('div');
    badge.className = 'agent-session-badge has-badge';
    badge.textContent = workspace;
    detailsRow.appendChild(badge);

    // Diff container
    const diffContainer = document.createElement('div');
    diffContainer.className = 'agent-session-diff-container' + (agent.diffStats && (agent.diffStats.added > 0 || agent.diffStats.removed > 0) ? ' has-diff' : '');
    const diffAdded = document.createElement('span');
    diffAdded.className = 'agent-session-diff-added';
    diffAdded.textContent = agent.diffStats ? '+' + agent.diffStats.added : '';
    const diffRemoved = document.createElement('span');
    diffRemoved.className = 'agent-session-diff-removed';
    diffRemoved.textContent = agent.diffStats ? '-' + agent.diffStats.removed : '';
    diffContainer.appendChild(diffAdded);
    diffContainer.appendChild(diffRemoved);
    detailsRow.appendChild(diffContainer);

    // Separator before time
    const sep = document.createElement('span');
    sep.className = 'agent-session-separator has-separator';
    detailsRow.appendChild(sep);

    // Status (elapsed time)
    const statusEl = document.createElement('div');
    statusEl.className = 'agent-session-status';
    const statusTime = document.createElement('span');
    statusTime.className = 'agent-session-status-time';
    statusTime.textContent = elapsed;
    statusEl.appendChild(statusTime);
    detailsRow.appendChild(statusEl);

    mainCol.appendChild(titleRow);
    mainCol.appendChild(detailsRow);

    // Approval row (always in DOM, shown with .visible)
    const approvalRow = buildApprovalRowEl(agent.id);
    if (agent.pendingApproval) {
      approvalRow.classList.add('visible');
      updateApprovalRowContent(approvalRow, agent.pendingApproval);
    }
    mainCol.appendChild(approvalRow);

    item.appendChild(iconCol);
    item.appendChild(mainCol);
    card.appendChild(item);

    // Click session-item row → expand / collapse output
    item.addEventListener('click', function(e) {
      if (e.target.tagName === 'BUTTON') return;
      if (expandedAgentId === agent.id) {
        collapseCard(card);
      } else {
        if (expandedAgentId) {
          const prev = document.querySelector('[data-agent-id="' + expandedAgentId + '"]');
          if (prev) collapseCard(prev);
        }
        doExpand(card, agent);
      }
    });

    if (isExpanded) doExpand(card, agent);

    return card;
  }

  function doExpand(card, agent) {
    expandedAgentId = agent.id;
    card.classList.add('agent-card-expanded');
    const toggle = card.querySelector('.agent-expand-toggle');
    if (toggle) toggle.textContent = '⌄';

    card.querySelectorAll('.agent-output-area, .agent-input-row').forEach(function(el) { el.remove(); });

    const outputArea = document.createElement('div');
    outputArea.className = 'agent-output-area';
    expandedOutputEl = outputArea;
    expandedRenderedCount = 0;

    for (const line of (agent.output || [])) {
      outputArea.appendChild(makeOutputLine(line));
      expandedRenderedCount++;
    }
    card.appendChild(outputArea);
    setTimeout(function() { outputArea.scrollTop = outputArea.scrollHeight; }, 0);

    if (agent.status === 'running') {
      card.appendChild(buildInputRow(agent.id));
    }
  }

  function collapseCard(card) {
    expandedAgentId = null;
    expandedOutputEl = null;
    expandedRenderedCount = 0;
    card.classList.remove('agent-card-expanded');
    const toggle = card.querySelector('.agent-expand-toggle');
    if (toggle) toggle.textContent = '›';
    card.querySelectorAll('.agent-output-area, .agent-input-row').forEach(function(el) { el.remove(); });
  }

  function buildInputRow(agentId) {
    const row = document.createElement('div');
    row.className = 'agent-input-row';

    const input = document.createElement('textarea');
    input.className = 'agent-input';
    input.placeholder = 'Send a message… (Enter to send, Shift+Enter for newline)';
    input.rows = 1;
    input.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(agentId, input); }
    });

    const sendBtn = document.createElement('button');
    sendBtn.className = 'agent-send-btn';
    sendBtn.textContent = '↑';
    sendBtn.title = 'Send (Enter)';
    sendBtn.addEventListener('click', function() { doSend(agentId, input); });

    row.appendChild(input);
    row.appendChild(sendBtn);
    return row;
  }

  function doSend(agentId, inputEl) {
    const text = inputEl.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'sendInput', id: agentId, text });
    inputEl.value = '';
    inputEl.style.height = 'auto';
  }

  function appendNewOutputLines(agent) {
    if (!expandedOutputEl) return;
    const lines = agent.output || [];
    const atBottom = expandedOutputEl.scrollTop + expandedOutputEl.clientHeight >= expandedOutputEl.scrollHeight - 40;
    while (expandedRenderedCount < lines.length) {
      expandedOutputEl.appendChild(makeOutputLine(lines[expandedRenderedCount]));
      expandedRenderedCount++;
    }
    if (atBottom) expandedOutputEl.scrollTop = expandedOutputEl.scrollHeight;
  }

  function updateCardBadge(agent) {
    const card = document.querySelector('[data-agent-id="' + agent.id + '"]');
    if (!card) return;

    // Icon
    const icon = card.querySelector('.agent-session-icon');
    if (icon) {
      const ia = agent.status === 'running' || agent.status === 'blocked';
      icon.className = 'agent-session-icon status-' + agent.status + (ia ? ' needs-input' : '');
    }

    // Status time
    const statusTime = card.querySelector('.agent-session-status-time');
    if (statusTime) statusTime.textContent = formatDuration(agent.startedAt);

    // Diff stats
    const diffContainer = card.querySelector('.agent-session-diff-container');
    if (diffContainer && agent.diffStats) {
      const hasNew = agent.diffStats.added > 0 || agent.diffStats.removed > 0;
      diffContainer.classList.toggle('has-diff', hasNew);
      const added = diffContainer.querySelector('.agent-session-diff-added');
      const removed = diffContainer.querySelector('.agent-session-diff-removed');
      if (added) added.textContent = '+' + agent.diffStats.added;
      if (removed) removed.textContent = '-' + agent.diffStats.removed;
    }

    // Approval row: toggle .visible and update content
    const approvalRow = card.querySelector('.agent-session-approval-row');
    if (approvalRow) {
      if (agent.pendingApproval) {
        updateApprovalRowContent(approvalRow, agent.pendingApproval);
        approvalRow.classList.add('visible');
      } else {
        approvalRow.classList.remove('visible');
      }
    }

    // Input row: only when running and expanded
    if (agent.status === 'running' && !card.querySelector('.agent-input-row') && card.classList.contains('agent-card-expanded')) {
      card.appendChild(buildInputRow(agent.id));
    }
    if (agent.status === 'completed' || agent.status === 'error' || agent.status === 'blocked') {
      card.querySelectorAll('.agent-input-row').forEach(function(el) { el.remove(); });
    }
  }

  function makeOutputLine(raw) {
    const isDim = raw.indexOf('\x1b[2m') !== -1;
    const div = document.createElement('div');
    div.className = 'output-line' + (isDim ? ' output-dim' : '');
    div.textContent = stripAnsi(raw);
    return div;
  }

  setInterval(function() {
    if (!agents.some(function(a) { return a.status === 'running' || a.status === 'blocked'; })) return;
    document.querySelectorAll('.agent-session-status-time').forEach(function(el) {
      const card = el.closest('[data-agent-id]');
      if (!card) return;
      const agent = agents.find(function(a) { return a.id === card.dataset.agentId; });
      if (agent) el.textContent = formatDuration(agent.startedAt);
    });
  }, 5000);

  // ── Sessions column ────────────────────────────────────

  let searchQuery = '';

  document.getElementById('new-session-btn').addEventListener('click', function () {
    document.getElementById('prompt-input').focus();
  });

  document.getElementById('refresh-sessions-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'refresh' });
  });

  const searchWrap = document.getElementById('search-wrap');
  const sessionsSearchInput = document.getElementById('sessions-search');
  let searchVisible = false;

  document.getElementById('search-toggle-btn').addEventListener('click', function () {
    searchVisible = !searchVisible;
    searchWrap.style.display = searchVisible ? 'block' : 'none';
    if (searchVisible) sessionsSearchInput.focus();
    else { searchQuery = ''; sessionsSearchInput.value = ''; applySessionsFilter(); }
  });

  sessionsSearchInput.addEventListener('input', function () {
    searchQuery = this.value.toLowerCase().trim();
    applySessionsFilter();
  });

  function applySessionsFilter() {
    document.querySelectorAll('#sessions-list .agent-session-item').forEach(function (item) {
      const title = (item.dataset.title || '').toLowerCase();
      const group = (item.dataset.group || '').toLowerCase();
      item.classList.toggle('filtered-out', !(!searchQuery || title.includes(searchQuery) || group.includes(searchQuery)));
    });
  }

  // Session item using VS Code's exact agent-session-item structure
  function createSessionItem(session, group) {
    const item = document.createElement('div');
    item.className = 'agent-session-item session-item';
    item.title = 'Resume in ' + group.workspacePath;
    item.dataset.workspacePath = group.workspacePath;
    item.dataset.sessionId = session.id;
    item.dataset.title = session.title;
    item.dataset.group = group.displayName;

    // Icon column
    const iconCol = document.createElement('div');
    iconCol.className = 'agent-session-icon-col';
    const iconEl = document.createElement('div');
    iconEl.className = 'agent-session-icon session-status-icon';
    iconCol.appendChild(iconEl);

    // Main column
    const mainCol = document.createElement('div');
    mainCol.className = 'agent-session-main-col';

    // Title row
    const titleRow = document.createElement('div');
    titleRow.className = 'agent-session-title-row';
    const titleEl = document.createElement('div');
    titleEl.className = 'agent-session-title';
    titleEl.textContent = session.title;
    titleRow.appendChild(titleEl);

    // Details row
    const detailsRow = document.createElement('div');
    detailsRow.className = 'agent-session-details-row';

    // Separator + status time (VS Code: status has has-separator for the · dot)
    const statusEl = document.createElement('div');
    statusEl.className = 'agent-session-status has-separator';
    const statusTime = document.createElement('span');
    statusTime.className = 'agent-session-status-time';
    statusTime.textContent = formatRelativeTime(session.timestamp);
    statusEl.appendChild(statusTime);
    detailsRow.appendChild(statusEl);

    mainCol.appendChild(titleRow);
    mainCol.appendChild(detailsRow);
    item.appendChild(iconCol);
    item.appendChild(mainCol);

    item.addEventListener('click', function () {
      vscode.postMessage({ type: 'resumeSession', sessionId: this.dataset.sessionId, workspacePath: this.dataset.workspacePath });
    });
    return item;
  }

  function renderSessions(groups) {
    currentGroups = groups;
    const container = document.getElementById('sessions-list');
    container.innerHTML = '';

    if (!groups || groups.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:12px 14px;font-size:12px;color:var(--vscode-descriptionForeground);opacity:0.42;font-style:italic';
      empty.textContent = 'No past sessions.';
      container.appendChild(empty);
      return;
    }

    const MAX_VISIBLE = 6;
    for (const group of groups) {
      // Section header — VS Code's .agent-session-section style
      const header = document.createElement('div');
      header.className = 'agent-session-section';
      const labelEl = document.createElement('span');
      labelEl.className = 'agent-session-section-label';
      labelEl.textContent = group.displayName.toUpperCase();
      const countEl = document.createElement('span');
      countEl.className = 'agent-session-section-count';
      countEl.textContent = String(group.sessions.length);
      header.appendChild(labelEl);
      header.appendChild(countEl);
      container.appendChild(header);

      const isExpanded = expandedGroups.has(group.workspacePath);
      const visible = isExpanded ? group.sessions : group.sessions.slice(0, MAX_VISIBLE);
      const hidden  = isExpanded ? [] : group.sessions.slice(MAX_VISIBLE);

      for (const s of visible) container.appendChild(createSessionItem(s, group));

      if (hidden.length > 0) {
        const more = document.createElement('div');
        more.className = 'agent-session-show-more';
        more.textContent = '+' + hidden.length + ' more';
        more.addEventListener('click', function () {
          expandedGroups.add(group.workspacePath);
          const anchor = this.nextSibling;
          this.remove();
          for (const s of hidden) container.insertBefore(createSessionItem(s, group), anchor);
        });
        container.appendChild(more);
      }
    }

    if (searchQuery) applySessionsFilter();
  }

  setInterval(function () {
    if (currentGroups.length > 0) renderSessions(currentGroups);
  }, 60000);

  // ── Customizations ─────────────────────────────────────

  let customizationsExpanded = false;

  document.getElementById('customizations-toggle').addEventListener('click', function () {
    customizationsExpanded = !customizationsExpanded;
    document.getElementById('customizations-body').style.display = customizationsExpanded ? 'block' : 'none';
    document.getElementById('customizations-chevron').textContent = customizationsExpanded ? '⌄' : '›';
  });

  function renderCustomizations(c) {
    const body = document.getElementById('customizations-body');
    body.innerHTML = '';
    const sections = [
      { icon: '⊙', label: 'Agents',      names: c.agents },
      { icon: '◈', label: 'Skills',       names: c.skills },
      { icon: '☰', label: 'Instructions', names: c.instructions },
      { icon: '⚡', label: 'Hooks',        names: c.hooks },
      { icon: '⊞', label: 'MCP Servers',  names: c.mcpServers },
    ];

    for (const section of sections) {
      const count = section.names.length;
      const row = document.createElement('div');
      row.className = 'customization-row' + (count > 0 ? ' customization-expandable' : '');
      row.innerHTML =
        '<div class="customization-left">' +
          '<span class="customization-icon">' + section.icon + '</span>' +
          '<span class="customization-label">' + escapeHtml(section.label) + '</span>' +
        '</div>' +
        (count > 0 ? '<span class="customization-count">' + count + ' <span class="cust-chevron">›</span></span>' : '');

      const subList = document.createElement('div');
      subList.className = 'customization-sublist';
      for (const name of section.names) {
        const sub = document.createElement('div');
        sub.className = 'customization-subitem';
        sub.textContent = name;
        subList.appendChild(sub);
      }

      if (count > 0) {
        const isOpen = expandedCustomSections.has(section.label);
        subList.style.display = isOpen ? 'block' : 'none';
        const chevron = row.querySelector('.cust-chevron');
        if (chevron) chevron.textContent = isOpen ? '⌄' : '›';
        row.addEventListener('click', function () {
          const nowOpen = expandedCustomSections.has(section.label);
          if (nowOpen) { expandedCustomSections.delete(section.label); subList.style.display = 'none'; const ch = row.querySelector('.cust-chevron'); if (ch) ch.textContent = '›'; }
          else { expandedCustomSections.add(section.label); subList.style.display = 'block'; const ch = row.querySelector('.cust-chevron'); if (ch) ch.textContent = '⌄'; }
        });
      }

      body.appendChild(row);
      if (count > 0) body.appendChild(subList);
    }
  }

  // ── File tree (right panel) ────────────────────────────

  let currentFileRoot = null;
  const treeState = new Map();
  const pendingExpand = new Set();

  function fileIcon(name, isDir) {
    if (isDir) return '📁';
    const ext = name.split('.').pop().toLowerCase();
    const icons = { ts:'🔷',tsx:'🔷',js:'🟨',jsx:'🟨',json:'{}',py:'🐍',go:'🔵',rs:'🦀',sh:'📜',md:'📝',txt:'📝',yml:'⚙',yaml:'⚙',toml:'⚙',html:'🌐',css:'🎨',svg:'🖼',sql:'🗄',db:'🗄' };
    return icons[ext] || '📄';
  }

  function buildTreeItem(entry, depth) {
    const indent = depth * 12;
    const wrapper = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'tree-item';
    row.style.paddingLeft = (indent + 6) + 'px';
    row.dataset.path = entry.path;
    row.dataset.isDir = entry.isDir ? '1' : '';

    if (entry.isDir) {
      const chevron = document.createElement('span');
      chevron.className = 'tree-chevron';
      chevron.textContent = '›';
      row.appendChild(chevron);
    } else {
      const spacer = document.createElement('span');
      spacer.style.cssText = 'width:10px;flex-shrink:0;display:inline-block';
      row.appendChild(spacer);
    }

    const icon = document.createElement('span');
    icon.className = 'tree-item-icon';
    icon.textContent = fileIcon(entry.name, entry.isDir);
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'tree-item-name';
    name.textContent = entry.name;
    row.appendChild(name);
    wrapper.appendChild(row);

    if (entry.isDir) {
      const childrenEl = document.createElement('div');
      childrenEl.className = 'tree-children';
      childrenEl.style.display = 'none';
      wrapper.appendChild(childrenEl);
      treeState.set(entry.path, { expanded: false, childrenEl, row, chevron: row.querySelector('.tree-chevron') });
      row.addEventListener('click', function () { toggleDir(entry.path, depth); });
    }

    return wrapper;
  }

  function toggleDir(dirPath, depth) {
    const state = treeState.get(dirPath);
    if (!state) return;
    if (state.expanded) {
      state.expanded = false; state.childrenEl.style.display = 'none'; state.chevron.classList.remove('open');
    } else {
      state.expanded = true; state.chevron.classList.add('open');
      if (state.childrenEl.children.length === 0) {
        const loading = document.createElement('div');
        loading.className = 'tree-loading'; loading.textContent = 'Loading…';
        state.childrenEl.appendChild(loading);
        pendingExpand.add(dirPath);
        vscode.postMessage({ type: 'getFiles', path: dirPath, depth });
      }
      state.childrenEl.style.display = 'block';
    }
  }

  function renderFileRoot(workspacePath, items) {
    currentFileRoot = workspacePath; treeState.clear();
    const tree = document.getElementById('file-tree');
    const empty = document.getElementById('files-empty');
    tree.innerHTML = '';
    if (!items || items.length === 0) { empty.style.display = ''; empty.textContent = 'Empty workspace.'; return; }
    empty.style.display = 'none';
    const rootName = workspacePath.split('/').pop() || workspacePath;
    const rootLabel = document.createElement('div');
    rootLabel.className = 'tree-root-label';
    rootLabel.innerHTML = '📂 <strong>' + escapeHtml(rootName) + '</strong>';
    tree.appendChild(rootLabel);
    for (const entry of items) tree.appendChild(buildTreeItem(entry, 0));
  }

  function handleFilesResponse(parentPath, items) {
    const state = treeState.get(parentPath);
    if (!state) return;
    state.childrenEl.innerHTML = '';
    for (const entry of items) {
      const depth = parseInt(state.row.style.paddingLeft || '6') / 12 + 1;
      state.childrenEl.appendChild(buildTreeItem(entry, depth));
    }
  }

  document.getElementById('tab-changes').addEventListener('click', function () { switchTab('changes'); });
  document.getElementById('tab-files').addEventListener('click', function () { switchTab('files'); });

  function switchTab(tab) {
    document.getElementById('panel-changes').style.display = tab === 'changes' ? 'flex' : 'none';
    document.getElementById('panel-files').style.display   = tab === 'files'   ? 'flex' : 'none';
    document.getElementById('tab-changes').classList.toggle('active', tab === 'changes');
    document.getElementById('tab-files').classList.toggle('active', tab === 'files');
  }

  // ── Workspace dropdown ─────────────────────────────────

  const workspaceDropdown = document.getElementById('workspace-dropdown');
  const workspaceLabel    = document.getElementById('workspace-label');
  const workspaceMenu     = document.getElementById('workspace-menu');

  function buildWorkspaceMenu() {
    workspaceMenu.innerHTML = '';
    for (const ws of init.workspacePaths) {
      const item = document.createElement('div');
      item.className = 'dropdown-item' + (ws.path === selectedWorkspace ? ' active' : '');
      item.textContent = ws.path; item.title = ws.path; item.dataset.path = ws.path;
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        selectedWorkspace = ws.path; workspaceLabel.textContent = ws.displayName;
        workspaceMenu.classList.remove('open');
        workspaceMenu.querySelectorAll('.dropdown-item').forEach(function(el) { el.classList.toggle('active', el === item); });
        vscode.postMessage({ type: 'workspaceChanged', workspacePath: ws.path });
      });
      workspaceMenu.appendChild(item);
    }
  }
  buildWorkspaceMenu();

  workspaceDropdown.addEventListener('click', function (e) { e.stopPropagation(); workspaceMenu.classList.toggle('open'); modelMenu.classList.remove('open'); });

  // ── Model dropdown ─────────────────────────────────────

  const MODELS = [
    { id: 'claude',                    label: 'Claude (latest)' },
    { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-7',           label: 'Claude Opus 4.7' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ];

  const modelDropdown  = document.getElementById('model-dropdown');
  const modelLabel     = document.getElementById('model-label');
  const modelMenu      = document.getElementById('model-menu');
  const modelChipLabel = document.getElementById('model-chip-label');

  for (const m of MODELS) {
    const item = document.createElement('div');
    item.className = 'dropdown-item' + (m.id === selectedModel ? ' active' : '');
    item.textContent = m.label;
    item.addEventListener('click', function (e) {
      e.stopPropagation();
      selectedModel = m.id; modelLabel.textContent = m.label; modelChipLabel.textContent = m.id;
      modelMenu.classList.remove('open');
      modelMenu.querySelectorAll('.dropdown-item').forEach(function(el) { el.classList.remove('active'); });
      item.classList.add('active');
    });
    modelMenu.appendChild(item);
  }

  modelDropdown.addEventListener('click', function (e) { e.stopPropagation(); modelMenu.classList.toggle('open'); workspaceMenu.classList.remove('open'); });
  document.getElementById('model-chip').addEventListener('click', function (e) { e.stopPropagation(); modelMenu.classList.toggle('open'); workspaceMenu.classList.remove('open'); });
  document.addEventListener('click', function () { workspaceMenu.classList.remove('open'); modelMenu.classList.remove('open'); });

  // ── Prompt / submit ────────────────────────────────────

  const promptInput      = document.getElementById('prompt-input');
  const submitBtn        = document.getElementById('submit-btn');
  const editAutoCheckbox = document.getElementById('edit-auto-checkbox');

  promptInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 240) + 'px';
  });
  promptInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
  });
  submitBtn.addEventListener('click', submit);

  function submit() {
    const description = promptInput.value.trim();
    if (!description) return;
    vscode.postMessage({ type: 'launch', workspacePath: selectedWorkspace, model: selectedModel, description, editAuto: editAutoCheckbox.checked });
  }

  // ── Message handler ────────────────────────────────────

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'setWorkspace') {
      selectedWorkspace = msg.workspacePath; workspaceLabel.textContent = msg.displayName;
      workspaceMenu.querySelectorAll('.dropdown-item').forEach(function(el) { el.classList.toggle('active', el.dataset.path === msg.workspacePath); });
    } else if (msg.type === 'agents') {
      agents = msg.agents; renderAgents();
    } else if (msg.type === 'sessions') {
      renderSessions(msg.groups); renderCustomizations(msg.customizations);
    } else if (msg.type === 'launchDone') {
      promptInput.value = ''; promptInput.style.height = 'auto'; promptInput.focus();
    } else if (msg.type === 'fileRoot') {
      renderFileRoot(msg.workspacePath, msg.items);
    } else if (msg.type === 'files') {
      handleFilesResponse(msg.parentPath, msg.items);
    }
  });

  // ── Initial render ─────────────────────────────────────

  renderSessions(init.groups || []);
  renderCustomizations(init.customizations || { agents: [], skills: [], instructions: [], hooks: [], mcpServers: [] });
  if (init.selectedWorkspace) vscode.postMessage({ type: 'workspaceChanged', workspacePath: init.selectedWorkspace });
  promptInput.focus();
  vscode.postMessage({ type: 'ready' });
})();
