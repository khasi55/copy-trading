/**
 * Zenvest MT5 Copy Trading Real Client Engine
 */

document.addEventListener('DOMContentLoaded', () => {
  // Application State
  let appState = {
    stats: { totalEquity: 0, totalBalance: 0, dailyPnL: 0, winRate: null, activeCopiersCount: 0, eaEngineOnline: false, eaEngineLatencyMs: null },
    masters: [],
    slaves: [],
    unassigned: [],
    trades: [],
    logs: [],
    equityHistory: []
  };

  // DOM References
  const totalEquityEl = document.getElementById('total-equity');
  const totalBalanceEl = document.getElementById('total-balance');
  const dailyPnlEl = document.getElementById('daily-pnl');
  const winRateEl = document.getElementById('win-rate');
  const activeSlavesCountEl = document.getElementById('active-slaves-count');
  const masterSlavesSubtextEl = document.getElementById('masters-slaves-subtext');
  const eaStatusDotEl = document.getElementById('ea-status-dot');
  const eaStatusTextEl = document.getElementById('ea-status-text');

  const mastersListEl = document.getElementById('masters-list');
  const slavesListEl = document.getElementById('slaves-list');
  const unassignedSectionEl = document.getElementById('unassigned-section');
  const unassignedListEl = document.getElementById('unassigned-list');
  const tradesTableBody = document.getElementById('trades-table-body');
  const logsTableBody = document.getElementById('logs-table-body');

  const addSlaveModal = document.getElementById('add-slave-modal');
  const eaModal = document.getElementById('ea-modal');
  const tokenModal = document.getElementById('token-modal');
  const tokenForm = document.getElementById('token-form');
  const tokenInput = document.getElementById('token-input');
  const tokenErrorEl = document.getElementById('token-error');

  const addSlaveBtn = document.getElementById('btn-add-slave');
  const openEaHubBtn = document.getElementById('btn-ea-hub');
  const emergencyCloseBtn = document.getElementById('btn-emergency-close');
  const slaveForm = document.getElementById('slave-form');

  // --- Shared API Token (required once the server has EA_API_TOKEN configured) ---
  const TOKEN_STORAGE_KEY = 'zenvest_api_token';

  function getApiToken() {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  }

  let pendingTokenPrompt = null;

  // Coalesces concurrent 401s (e.g. the 3 parallel calls on first load) into a single modal instance
  function promptForApiToken(showError) {
    if (pendingTokenPrompt) return pendingTokenPrompt;
    pendingTokenPrompt = new Promise((resolve) => {
      tokenErrorEl.style.display = showError ? 'block' : 'none';
      tokenInput.value = '';
      tokenModal.classList.add('active');
      setTimeout(() => tokenInput.focus(), 0);

      const onSubmit = (e) => {
        e.preventDefault();
        const entered = tokenInput.value.trim();
        if (!entered) return;
        localStorage.setItem(TOKEN_STORAGE_KEY, entered);
        tokenModal.classList.remove('active');
        tokenForm.removeEventListener('submit', onSubmit);
        pendingTokenPrompt = null;
        resolve(entered);
      };
      tokenForm.addEventListener('submit', onSubmit);
    });
    return pendingTokenPrompt;
  }

  async function apiFetch(url, options = {}, attempt = 0) {
    const headers = Object.assign({}, options.headers || {});
    const token = getApiToken();
    if (token) headers['X-API-Token'] = token;

    const res = await fetch(url, Object.assign({}, options, { headers }));
    if (res.status === 401 && attempt < 5) {
      await promptForApiToken(attempt > 0);
      return apiFetch(url, options, attempt + 1);
    }
    return res;
  }

  // --- Initial Data Fetch ---
  async function fetchInitialData() {
    try {
      const [statsRes, accountsRes, tradesRes] = await Promise.all([
        apiFetch('/api/stats'),
        apiFetch('/api/accounts'),
        apiFetch('/api/trades')
      ]);

      appState.stats = await statsRes.json();
      const accounts = await accountsRes.json();
      appState.masters = accounts.masters || [];
      appState.slaves = accounts.slaves || [];
      appState.unassigned = accounts.unassigned || [];

      const tradeData = await tradesRes.json();
      appState.trades = tradeData.trades || [];
      appState.logs = tradeData.logs || [];

      renderDashboard();
    } catch (err) {
      console.error('Error fetching initial real MT5 data:', err);
    }
  }

  // --- Real-time SSE Stream ---
  function initSSE() {
    // EventSource can't set custom headers, so the token travels as a query param here
    const token = getApiToken();
    const streamUrl = token ? `/api/stream?token=${encodeURIComponent(token)}` : '/api/stream';
    const sse = new EventSource(streamUrl);

    sse.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'TICK_UPDATE') {
          appState.trades = payload.data.trades || [];
          appState.stats = payload.data.stats || {};
          appState.masters = payload.data.masters || [];
          appState.slaves = payload.data.slaves || [];
          appState.unassigned = payload.data.unassigned || [];


          if (appState.stats.totalEquity !== undefined) {
            appState.equityHistory.push(appState.stats.totalEquity);
            if (appState.equityHistory.length > 30) appState.equityHistory.shift();
          }

          renderMetrics();
          renderAccounts();
          renderTrades();
          drawEquityChart();
        } else if (payload.type === 'SLAVE_ADDED' || payload.type === 'SLAVE_UPDATED') {
          fetchInitialData();
        } else if (payload.type === 'EMERGENCY_CLOSE_ALL') {
          appState.trades = [];
          renderDashboard();
        }
      } catch (e) {
        console.error('Error processing SSE telemetry', e);
      }
    };

    sse.onerror = () => {
      console.warn('SSE stream disconnected, reconnecting...');
    };
  }

  // --- Render Dashboard Views ---
  function renderDashboard() {
    renderMetrics();
    renderAccounts();
    renderTrades();
    renderLogs();
    drawEquityChart();
  }

  function renderMetrics() {
    const s = appState.stats || {};

    totalEquityEl.textContent = `$${(s.totalEquity || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    totalBalanceEl.textContent = `$${(s.totalBalance || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    
    const pnl = s.dailyPnL || 0;
    dailyPnlEl.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    dailyPnlEl.className = `metric-value ${pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`;

    winRateEl.textContent = (s.winRate === null || s.winRate === undefined) ? '—%' : `${s.winRate}%`;
    activeSlavesCountEl.textContent = `${s.activeCopiersCount || 0}`;

    if (masterSlavesSubtextEl) {
      masterSlavesSubtextEl.textContent = `Across ${appState.masters.length} Master${appState.masters.length === 1 ? '' : 's'} & ${appState.slaves.length} Connected Slave${appState.slaves.length === 1 ? '' : 's'}`;
    }

    if (eaStatusDotEl && eaStatusTextEl) {
      if (s.eaEngineOnline) {
        eaStatusDotEl.style.background = 'var(--accent-green)';
        eaStatusDotEl.style.boxShadow = '0 0 10px var(--accent-green)';
        eaStatusTextEl.textContent = `EA Engine Online${s.eaEngineLatencyMs !== null && s.eaEngineLatencyMs !== undefined ? ` (${s.eaEngineLatencyMs}ms)` : ''}`;
      } else {
        eaStatusDotEl.style.background = 'var(--accent-red)';
        eaStatusDotEl.style.boxShadow = '0 0 10px var(--accent-red)';
        eaStatusTextEl.textContent = 'No EA Connected';
      }
    }
  }

  function renderAccounts() {
    // Render accounts that have connected via the EA but have no Master/Slave assignment yet
    if (unassignedSectionEl && unassignedListEl) {
      if (appState.unassigned.length === 0) {
        unassignedSectionEl.style.display = 'none';
      } else {
        unassignedSectionEl.style.display = '';
        unassignedListEl.innerHTML = appState.unassigned.map(a => `
          <div class="account-card">
            <div class="account-card-header">
              <div>
                <div class="account-name">${escapeHtml(a.accountName)}</div>
                <div class="account-broker">${escapeHtml(a.broker || '')} • ${escapeHtml(a.server || '')}</div>
              </div>
              <span class="status-badge status-paused">UNASSIGNED</span>
            </div>
            <div class="account-stats-row">
              <div class="stat-item">
                <label>Balance</label>
                <span>$${(a.balance || 0).toLocaleString()}</span>
              </div>
              <div class="stat-item">
                <label>Equity</label>
                <span>$${(a.equity || 0).toLocaleString()}</span>
              </div>
              <div class="stat-item">
                <label>MT5 Login ID</label>
                <span>${escapeHtml(a.accountNumber)}</span>
              </div>
            </div>
            <div class="account-actions">
              <span style="color: var(--text-muted);">Choose this account's role:</span>
              <div>
                <button class="btn btn-primary" style="padding: 4px 8px; font-size: 11px;" onclick="assignAccountRole('${a.accountNumber}', 'MASTER')">Set as Master</button>
                <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 11px;" onclick="assignAccountRole('${a.accountNumber}', 'SLAVE')">Set as Slave</button>
              </div>
            </div>
          </div>
        `).join('');
      }
    }

    // Render Master Accounts
    if (appState.masters.length === 0) {
      mastersListEl.innerHTML = `
        <div style="padding: 20px; text-align: center; color: var(--text-muted); border: 1px dashed var(--border-color); border-radius: 8px;">
          No MT5 Master connected yet.<br>
          <small style="color: var(--text-dim);">Install <strong>ZenCopyTrader.mq5</strong> on the account's MT5 terminal, then set its role as Master above once it connects.</small>
        </div>
      `;
    } else {
      mastersListEl.innerHTML = appState.masters.map(m => `
        <div class="account-card master-card">
          <div class="account-card-header">
            <div>
              <div class="account-name">${escapeHtml(m.accountName)}</div>
              <div class="account-broker">Server: <strong>${escapeHtml(m.server)}</strong></div>
            </div>
            <span class="status-badge status-active">MASTER</span>
          </div>
          <div class="account-stats-row">
            <div class="stat-item">
              <label>Balance</label>
              <span>$${(m.balance || 0).toLocaleString()}</span>
            </div>
            <div class="stat-item">
              <label>Equity</label>
              <span>$${(m.equity || 0).toLocaleString()}</span>
            </div>
            <div class="stat-item">
              <label>Floating PnL</label>
              <span class="${(m.floatingPnL || 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}">
                ${(m.floatingPnL || 0) >= 0 ? '+' : ''}$${(m.floatingPnL || 0).toFixed(2)}
              </span>
            </div>
            <div class="stat-item">
              <label>Open Positions</label>
              <span>${m.openPositions || 0} trades</span>
            </div>
          </div>
          <div class="account-actions">
            <span style="color: var(--text-muted);">MT5 Login ID: <strong>${m.accountNumber}</strong></span>
            <span style="color: var(--accent-green);">Live Data Feed</span>
          </div>
        </div>
      `).join('');
    }

    // Render Slave Accounts
    if (appState.slaves.length === 0) {
      slavesListEl.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 30px; text-align: center; color: var(--text-muted); background: rgba(255,255,255,0.02); border: 1px dashed var(--border-color); border-radius: 12px;">
          No Slave Accounts linked yet.<br>
          Click <strong>"+ Link Slave MT5 Account"</strong> to pre-configure risk rules, then install the EA on that account's MT5 terminal.
        </div>
      `;
    } else {
      slavesListEl.innerHTML = appState.slaves.map(s => `
        <div class="account-card slave-card">
          <div class="account-card-header">
            <div>
              <div class="account-name">${escapeHtml(s.accountName)}</div>
              <div class="account-broker">${escapeHtml(s.broker)} • ${escapeHtml(s.server)}</div>
            </div>
            <span class="status-badge status-${s.status}">${s.status.toUpperCase()}</span>
          </div>
          <div class="account-stats-row">
            <div class="stat-item">
              <label>Balance</label>
              <span>$${(s.balance || 0).toLocaleString()}</span>
            </div>
            <div class="stat-item">
              <label>Equity</label>
              <span>$${(s.equity || 0).toLocaleString()}</span>
            </div>
            <div class="stat-item">
              <label>Floating PnL</label>
              <span class="${(s.floatingPnL || 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}">
                ${(s.floatingPnL || 0) >= 0 ? '+' : ''}$${(s.floatingPnL || 0).toFixed(2)}
              </span>
            </div>
            <div class="stat-item">
              <label>Risk Sizing</label>
              <span>${s.riskSettings ? (s.riskSettings.mode === 'multiplier' ? `${s.riskSettings.multiplier}x Multiplier` : `${s.riskSettings.mode}`) : '1.0x'}</span>
            </div>
          </div>
          <div class="account-actions">
            <span>Latency: <strong style="color: var(--accent-green);">${(s.latencyMs === null || s.latencyMs === undefined) ? 'Not connected' : s.latencyMs + 'ms'}</strong></span>
            <div>
              <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 11px;" onclick="toggleSlaveStatus('${s.id}', '${s.status === 'active' ? 'paused' : 'active'}')">
                ${s.status === 'active' ? 'Pause Sync' : 'Resume Sync'}
              </button>
              <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="removeSlave('${s.id}')">
                Unlink
              </button>
            </div>
          </div>
        </div>
      `).join('');
    }
  }

  function renderTrades() {
    if (appState.trades.length === 0) {
      tradesTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 28px;">No active real positions open on Master MT5 account.</td></tr>`;
      return;
    }

    tradesTableBody.innerHTML = appState.trades.map(t => `
      <tr>
        <td><strong>#${t.ticket}</strong></td>
        <td><strong>${t.symbol}</strong></td>
        <td><span class="${t.type === 'BUY' ? 'type-buy' : 'type-sell'}">${t.type}</span></td>
        <td>${t.volume.toFixed(2)} lots</td>
        <td>$${t.openPrice.toFixed(t.symbol === 'EURUSD' ? 5 : 2)}</td>
        <td>$${t.currentPrice.toFixed(t.symbol === 'EURUSD' ? 5 : 2)}</td>
        <td class="${t.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}</td>
        <td>
          <span class="status-badge status-active">${t.copiedSlaves ? t.copiedSlaves.length : 0} Slaves Synced</span>
        </td>
      </tr>
    `).join('');
  }

  function renderLogs() {
    if (appState.logs.length === 0) {
      logsTableBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 16px;">No event logs recorded yet.</td></tr>`;
      return;
    }

    logsTableBody.innerHTML = appState.logs.slice(0, 6).map(l => `
      <tr>
        <td style="color: var(--text-dim); font-size: 11px;">${new Date(l.timestamp).toLocaleTimeString()}</td>
        <td><strong style="color: var(--primary);">${l.event}</strong></td>
        <td style="font-size: 12px; color: var(--text-muted);">${escapeHtml(l.details)}</td>
      </tr>
    `).join('');
  }

  // Canvas Equity Curve Drawing
  function drawEquityChart() {
    const canvas = document.getElementById('equity-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);

    const data = appState.equityHistory;
    if (data.length < 2) return;

    const width = rect.width;
    const height = rect.height;
    const padding = 20;

    const minVal = Math.min(...data) * 0.99;
    const maxVal = Math.max(...data) * 1.01;

    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const y = (height / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(width - padding, y);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';

    const stepX = (width - padding * 2) / (data.length - 1);
    data.forEach((val, i) => {
      const x = padding + i * stepX;
      const y = height - padding - ((val - minVal) / (maxVal - minVal)) * (height - padding * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.25)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');
    ctx.lineTo(padding + (data.length - 1) * stepX, height - padding);
    ctx.lineTo(padding, height - padding);
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  // --- Handlers & Actions ---
  window.assignAccountRole = async (accountNumber, role) => {
    try {
      const res = await apiFetch(`/api/accounts/${encodeURIComponent(accountNumber)}/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role })
      });
      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        alert(result.error || 'Failed to assign account role');
        return;
      }
      fetchInitialData();
    } catch (e) {
      alert('Failed to assign account role');
    }
  };

  window.toggleSlaveStatus = async (id, status) => {
    try {
      await apiFetch(`/api/accounts/slave/${id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      fetchInitialData();
    } catch (e) {
      alert('Failed to update slave account status');
    }
  };

  window.removeSlave = async (id) => {
    if (!confirm('Are you sure you want to unlink this MT5 slave account?')) return;
    try {
      await apiFetch(`/api/accounts/slave/${id}`, { method: 'DELETE' });
      fetchInitialData();
    } catch (e) {
      alert('Failed to delete slave account');
    }
  };

  // Modals
  addSlaveBtn.addEventListener('click', () => addSlaveModal.classList.add('active'));
  openEaHubBtn.addEventListener('click', () => eaModal.classList.add('active'));

  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      addSlaveModal.classList.remove('active');
      eaModal.classList.remove('active');
    });
  });

  slaveForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(slaveForm);
    const payload = Object.fromEntries(formData.entries());

    try {
      const res = await apiFetch('/api/accounts/slave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const result = await res.json();
      if (res.ok) {
        addSlaveModal.classList.remove('active');
        slaveForm.reset();
        fetchInitialData();
      } else {
        alert(result.error || 'Failed to connect slave account');
      }
    } catch (err) {
      alert('Server communication error');
    }
  });

  emergencyCloseBtn.addEventListener('click', async () => {
    if (!confirm('EMERGENCY ACTION: Dispatch CLOSE ALL command to all connected real MT5 terminals?')) return;
    try {
      await apiFetch('/api/trades/close-all', { method: 'POST' });
      fetchInitialData();
    } catch (e) {
      alert('Failed to execute emergency close');
    }
  });

  // Auto-Installer Action
  async function triggerAutoInstall() {
    try {
      const res = await apiFetch('/api/ea/auto-install', { method: 'POST' });
      const result = await res.json();
      if (result.success) {
        alert(`✅ ${result.message}\n\nInstalled to:\n${result.installedPaths.join('\n')}`);
        fetchInitialData();
      } else {
        alert(`⚠️ Auto-Installer Notice: ${result.message || 'Could not locate MT5 directory automatically.'}`);
      }
    } catch (e) {
      alert('Failed to communicate with Auto-Installer service.');
    }
  }

  const btnAutoInstall = document.getElementById('btn-auto-install');
  const btnModalAutoInstall = document.getElementById('btn-modal-auto-install');
  if (btnAutoInstall) btnAutoInstall.addEventListener('click', triggerAutoInstall);
  if (btnModalAutoInstall) btnModalAutoInstall.addEventListener('click', triggerAutoInstall);

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Initialize
  const eaWebhookUrlEl = document.getElementById('ea-webhook-url');
  if (eaWebhookUrlEl) eaWebhookUrlEl.textContent = `${window.location.origin}/api/ea/sync`;

  // Wait for a valid token (fetchInitialData resolves the token-gate modal on 401) before
  // opening the SSE stream, since EventSource can't be redirected mid-flight with a new URL.
  fetchInitialData().then(initSSE);
  window.addEventListener('resize', drawEquityChart);
});
