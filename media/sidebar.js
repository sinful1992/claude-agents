(function () {
  const vscode = acquireVsCodeApi();
  let currentGroups = [];
  let sessionsExpanded = true;
  let customizationsExpanded = false;
  const expandedGroups = new Set();
  const expandedCustomSections = new Set();

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatRelativeTime(epochMs) {
    const d = Math.floor((Date.now() - epochMs) / 1000);
    if (d < 60) return d + 's';
    if (d < 3600) return Math.floor(d / 60) + 'm';
    if (d < 86400) return Math.floor(d / 3600) + 'h';
    return Math.floor(d / 86400) + 'd';
  }

  function formatDuration(startMs) {
    const s = Math.floor((Date.now() - startMs) / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  // --- Agents ---

  const STATUS_LABELS = { running: 'WORK', blocked: 'WAIT', completed: 'DONE', done: 'DONE', error: 'ERR' };

  function renderAgents(agents) {
    const list = document.getElementById('agents-list');
    list.innerHTML = '';

    if (!agents || agents.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No active agents. Click New to start one.';
      list.appendChild(empty);
      return;
    }

    for (const agent of agents) {
      const item = document.createElement('div');
      item.className = 'agent-item status-' + agent.status;
      item.dataset.id = agent.id;

      const info = document.createElement('div');
      info.className = 'agent-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'agent-task';
      nameEl.textContent = agent.name;

      const descEl = document.createElement('div');
      descEl.className = 'agent-description';
      descEl.textContent = agent.description;

      const meta = document.createElement('div');
      meta.className = 'agent-meta';
      const elapsed = agent.status === 'running' || agent.status === 'waiting'
        ? formatDuration(agent.startedAt)
        : formatRelativeTime(agent.startedAt) + ' ago';
      const badge = STATUS_LABELS[agent.status] || agent.status.toUpperCase();
      meta.innerHTML = '<span class="agent-status-badge badge-' + agent.status + '">' + badge + '</span>' + escapeHtml(agent.model) + ' · ' + elapsed;

      info.appendChild(nameEl);
      info.appendChild(descEl);
      info.appendChild(meta);
      item.appendChild(info);

      if (agent.status === 'running' || agent.status === 'blocked') {
        item.title = agent.status === 'blocked' ? 'Waiting for input — click to attach' : 'Click to attach to agent';
        item.addEventListener('click', function () {
          vscode.postMessage({ type: 'focusAgent', id: this.dataset.id });
        });
      }

      list.appendChild(item);
    }
  }

  // Re-request agents every 5s to update elapsed time
  setInterval(function () {
    vscode.postMessage({ type: 'refresh' });
  }, 5000);

  // --- Sessions ---

  function createSessionItem(session, group) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.title = 'Resume session in ' + group.workspacePath;
    item.dataset.workspacePath = group.workspacePath;
    item.dataset.sessionId = session.id;

    const dot = document.createElement('span');
    dot.className = 'dot';

    const info = document.createElement('div');
    info.className = 'session-info';

    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = session.title;

    const time = document.createElement('div');
    time.className = 'session-time';
    time.textContent = '✳ · ' + formatRelativeTime(session.timestamp) + ' ago';

    info.appendChild(title);
    info.appendChild(time);
    item.appendChild(dot);
    item.appendChild(info);

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
      empty.className = 'empty-state';
      empty.textContent = 'No past sessions found.';
      container.appendChild(empty);
      return;
    }

    const MAX_VISIBLE = 5;

    for (const group of groups) {
      const header = document.createElement('div');
      header.className = 'group-header';
      header.textContent = group.displayName.toUpperCase();
      container.appendChild(header);

      const isExpanded = expandedGroups.has(group.workspacePath);
      const visible = isExpanded ? group.sessions : group.sessions.slice(0, MAX_VISIBLE);
      const hidden  = isExpanded ? [] : group.sessions.slice(MAX_VISIBLE);

      for (const s of visible) container.appendChild(createSessionItem(s, group));

      if (hidden.length > 0) {
        const more = document.createElement('div');
        more.className = 'more-row';
        more.textContent = '+' + hidden.length + ' more';
        more.addEventListener('click', function () {
          expandedGroups.add(group.workspacePath);
          const anchor = this.nextSibling;
          this.remove();
          for (const s of hidden) {
            container.insertBefore(createSessionItem(s, group), anchor);
          }
        });
        container.appendChild(more);
      }
    }
  }

  // Refresh timestamps every 60s
  setInterval(function () {
    if (currentGroups.length > 0) renderSessions(currentGroups);
  }, 60000);

  // --- Customizations ---

  function renderCustomizations(c) {
    const body = document.getElementById('customizations-body');
    body.innerHTML = '';
    const sections = [
      { icon: '⊙', label: 'Agents',       names: c.agents },
      { icon: '◈', label: 'Skills',        names: c.skills },
      { icon: '☰', label: 'Instructions',  names: c.instructions },
      { icon: '⚡', label: 'Hooks',         names: c.hooks },
      { icon: '⊞', label: 'MCP Servers',   names: c.mcpServers },
    ];
    for (const section of sections) {
      const count = section.names.length;

      // Header row — clickable only when there are items
      const row = document.createElement('div');
      row.className = 'customization-row' + (count > 0 ? ' customization-expandable' : '');
      row.innerHTML =
        '<div class="customization-left">' +
          '<span class="customization-icon">' + section.icon + '</span>' +
          '<span class="customization-label">' + escapeHtml(section.label) + '</span>' +
        '</div>' +
        (count > 0
          ? '<span class="customization-count">' + count + ' <span class="cust-chevron">›</span></span>'
          : '');

      // Sub-list (hidden by default)
      const subList = document.createElement('div');
      subList.className = 'customization-sublist';
      subList.style.display = 'none';
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
          if (nowOpen) {
            expandedCustomSections.delete(section.label);
            subList.style.display = 'none';
            const ch = row.querySelector('.cust-chevron');
            if (ch) ch.textContent = '›';
          } else {
            expandedCustomSections.add(section.label);
            subList.style.display = 'block';
            const ch = row.querySelector('.cust-chevron');
            if (ch) ch.textContent = '⌄';
          }
        });
      }

      body.appendChild(row);
      if (count > 0) body.appendChild(subList);
    }
  }

  // --- Message handling ---

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'agents') {
      renderAgents(msg.agents);
    } else if (msg.type === 'sessions') {
      renderSessions(msg.groups);
      renderCustomizations(msg.customizations);
    }
  });

  // --- Controls ---

  document.getElementById('sessions-toggle').addEventListener('click', function () {
    sessionsExpanded = !sessionsExpanded;
    document.getElementById('sessions-list').style.display = sessionsExpanded ? 'block' : 'none';
    document.getElementById('sessions-chevron').textContent = sessionsExpanded ? '⌄' : '›';
  });

  document.getElementById('customizations-toggle').addEventListener('click', function () {
    customizationsExpanded = !customizationsExpanded;
    document.getElementById('customizations-body').style.display = customizationsExpanded ? 'block' : 'none';
    document.getElementById('customizations-chevron').textContent = customizationsExpanded ? '⌄' : '›';
  });

  vscode.postMessage({ type: 'ready' });
})();
