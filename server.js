const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { installEA } = require('./scripts/install_ea');

// Minimal .env loader for local dev (no dependency). Railway/production sets real env vars directly.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  });
})();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'store.json');
const API_TOKEN = process.env.EA_API_TOKEN || null;

if (!API_TOKEN) {
  console.warn('WARNING: EA_API_TOKEN is not set. All API endpoints are running WITHOUT authentication.');
  console.warn('Set EA_API_TOKEN in your environment (or a local .env file) before exposing this server publicly.');
}

function isAuthorized(req, parsedUrl) {
  if (!API_TOKEN) return true; // no token configured (e.g. quick local test) — auth disabled
  const headerToken = req.headers['x-api-token'] || req.headers['x-ea-key'];
  const queryToken = parsedUrl.searchParams.get('token');
  const provided = headerToken || queryToken || '';
  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(API_TOKEN);
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// --- Persistent Real Datastore ---
let store = {
  stats: {
    totalEquity: 0.00,
    totalBalance: 0.00,
    dailyPnL: 0.00,
    dailyPnLPercent: 0.00,
    winRate: null,
    copiedVolumeLots: 0.00,
    activeCopiersCount: 0,
    masterTradesCount: 0,
    avgExecutionLatencyMs: null,
    eaEngineOnline: false,
    eaEngineLatencyMs: null
  },
  masters: [],
  slaves: [],
  unassigned: [],
  roleAssignments: {}, // accountNumber -> 'MASTER' | 'SLAVE', set from the dashboard, not the EA
  trades: [],
  executionLogs: [],
  pendingEaCommands: []
};

// Real EA connections are considered "online" only if any account reported in within this window
const EA_ONLINE_WINDOW_MS = 15000;
let lastEaSyncAt = null;

// Load existing real data if present, merged onto the defaults above so fields added in later
// versions of this file (e.g. unassigned/roleAssignments) aren't wiped out by an older store.json
if (fs.existsSync(DATA_FILE)) {
  try {
    const fileData = fs.readFileSync(DATA_FILE, 'utf8');
    const loaded = JSON.parse(fileData);
    store = Object.assign({}, store, loaded, { stats: Object.assign({}, store.stats, loaded.stats) });
    console.log('Loaded persistent real MT5 account datastore.');
  } catch (e) {
    console.error('Error loading store.json:', e);
  }
}

function saveStore() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Error saving store.json:', e);
  }
}

// SSE Subscription Client Pool
const wsClients = new Set();

function broadcastData(event, data) {
  const payload = JSON.stringify({ type: event, data });
  for (const client of wsClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (e) {
      wsClients.delete(client);
    }
  }
}

// Recalculate real statistics across active accounts and positions
function updateRealStats() {
  let totalBal = 0;
  let totalEq = 0;
  let totalPnl = 0;

  store.masters.forEach(m => {
    totalBal += (m.balance || 0);
    totalEq += (m.equity || 0);
    totalPnl += (m.floatingPnL || 0);
  });

  store.slaves.forEach(s => {
    totalBal += (s.balance || 0);
    totalEq += (s.equity || 0);
    totalPnl += (s.floatingPnL || 0);
  });

  store.stats.totalBalance = parseFloat(totalBal.toFixed(2));
  store.stats.totalEquity = parseFloat(totalEq.toFixed(2));
  store.stats.dailyPnL = parseFloat(totalPnl.toFixed(2));
  store.stats.activeCopiersCount = store.slaves.filter(s => s.status === 'active').length;
  store.stats.masterTradesCount = store.trades.length;

  // Win rate: real closed-deal wins/losses reported by the Master EA from MT5 history, not a guess
  let totalWins = 0;
  let totalLosses = 0;
  store.masters.forEach(m => {
    totalWins += (m.closedWins || 0);
    totalLosses += (m.closedLosses || 0);
  });
  store.stats.winRate = (totalWins + totalLosses) > 0
    ? parseFloat(((totalWins / (totalWins + totalLosses)) * 100).toFixed(1))
    : null;

  // Copied volume: real sum of lots actually mirrored across active slaves on current open trades
  store.stats.copiedVolumeLots = parseFloat(
    store.trades
      .flatMap(t => t.copiedSlaves || [])
      .filter(cs => cs.status === 'synced')
      .reduce((sum, cs) => sum + (cs.volume || 0), 0)
      .toFixed(2)
  );

  // Avg execution latency: real reported round-trip ping from connected slave EAs only
  const knownLatencies = store.slaves.map(s => s.latencyMs).filter(v => typeof v === 'number');
  store.stats.avgExecutionLatencyMs = knownLatencies.length > 0
    ? Math.round(knownLatencies.reduce((a, b) => a + b, 0) / knownLatencies.length)
    : null;

  // EA bridge status: online only if some account has actually reported telemetry recently
  store.stats.eaEngineOnline = lastEaSyncAt !== null && (Date.now() - lastEaSyncAt) < EA_ONLINE_WINDOW_MS;
  store.stats.eaEngineLatencyMs = store.stats.eaEngineOnline ? store.stats.avgExecutionLatencyMs : null;

  saveStore();
  broadcastData('TICK_UPDATE', {
    trades: store.trades,
    stats: store.stats,
    masters: store.masters,
    slaves: store.slaves,
    unassigned: store.unassigned
  });
}

// Server Routing & Request Handler
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-EA-Key, X-API-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // --- Auth gate: every /api/* route (including SSE) requires the shared token once EA_API_TOKEN is set ---
  if (pathname.startsWith('/api/') && !isAuthorized(req, parsedUrl)) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(401);
    return res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid API token' }));
  }

  // --- Real-time SSE Stream ---
  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    wsClients.add(res);
    req.on('close', () => wsClients.delete(res));
    return;
  }

  // --- REST API Endpoints ---
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');

    // GET /api/stats
    if (req.method === 'GET' && pathname === '/api/stats') {
      res.writeHead(200);
      return res.end(JSON.stringify(store.stats));
    }

    // GET /api/accounts
    if (req.method === 'GET' && pathname === '/api/accounts') {
      res.writeHead(200);
      return res.end(JSON.stringify({
        masters: store.masters,
        slaves: store.slaves,
        unassigned: store.unassigned
      }));
    }

    // POST /api/accounts/:accountNumber/role — dashboard-driven Master/Slave assignment.
    // This is the only place an account's role is decided; the EA's own role input is ignored.
    if (req.method === 'POST' && /^\/api\/accounts\/[^/]+\/role$/.test(pathname)) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const accountNo = decodeURIComponent(pathname.split('/')[3]);
          const data = JSON.parse(body || '{}');
          const role = data.role;

          if (role !== 'MASTER' && role !== 'SLAVE') {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'role must be MASTER or SLAVE' }));
          }

          const pendingIndex = store.unassigned.findIndex(a => a.accountNumber === accountNo);
          if (pendingIndex === -1) {
            res.writeHead(404);
            return res.end(JSON.stringify({ error: 'No unassigned connected account with that number' }));
          }
          const acc = store.unassigned[pendingIndex];
          store.unassigned.splice(pendingIndex, 1);
          store.roleAssignments[accountNo] = role;

          if (role === 'MASTER') {
            store.masters.push({
              id: 'MST-' + accountNo,
              accountNumber: accountNo,
              accountName: acc.accountName,
              broker: acc.broker,
              server: acc.server,
              balance: acc.balance,
              equity: acc.equity,
              margin: acc.margin,
              freeMargin: acc.freeMargin,
              floatingPnL: acc.floatingPnL,
              openPositions: 0,
              status: 'active',
              lastSeen: acc.lastSeen
            });
          } else {
            store.slaves.push({
              id: 'SLV-' + accountNo,
              accountNumber: accountNo,
              accountName: acc.accountName,
              broker: acc.broker,
              server: acc.server,
              balance: acc.balance,
              equity: acc.equity,
              margin: acc.margin,
              freeMargin: acc.freeMargin,
              floatingPnL: acc.floatingPnL,
              status: 'active',
              lastSeen: acc.lastSeen,
              latencyMs: acc.latencyMs,
              riskSettings: { mode: 'multiplier', multiplier: 1.0, fixedLot: 0.1, maxSpreadPips: 3.0 }
            });
          }

          store.executionLogs.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            event: 'ROLE_ASSIGNED',
            account: accountNo,
            details: `Account ${accountNo} assigned as ${role} from the dashboard`
          });

          updateRealStats();
          res.writeHead(200);
          return res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    // POST /api/accounts/master
    if (req.method === 'POST' && pathname === '/api/accounts/master') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (!data.accountNumber || !data.server) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'Account number and MT5 Server required' }));
          }

          let master = store.masters.find(m => m.accountNumber === String(data.accountNumber));
          if (!master) {
            master = {
              id: 'MST-' + data.accountNumber,
              accountNumber: String(data.accountNumber),
              accountName: data.accountName || `Master MT5 (${data.accountNumber})`,
              broker: data.broker || data.server,
              server: data.server,
              balance: parseFloat(data.balance || 0),
              equity: parseFloat(data.equity || 0),
              margin: parseFloat(data.margin || 0),
              freeMargin: parseFloat(data.freeMargin || 0),
              floatingPnL: parseFloat(data.floatingPnL || 0),
              openPositions: 0,
              status: 'active',
              lastSeen: new Date().toISOString()
            };
            store.masters.push(master);
          }
          store.roleAssignments[master.accountNumber] = 'MASTER';

          updateRealStats();
          res.writeHead(201);
          return res.end(JSON.stringify({ success: true, master }));
        } catch (e) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    // POST /api/accounts/slave
    if (req.method === 'POST' && pathname === '/api/accounts/slave') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (!data.accountNumber || !data.server) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'MT5 Account Number and Server are required' }));
          }

          let newSlave = store.slaves.find(s => s.accountNumber === String(data.accountNumber));
          if (!newSlave) {
            newSlave = {
              id: 'SLV-' + data.accountNumber,
              accountNumber: String(data.accountNumber),
              accountName: data.accountName || `MT5 Slave (${data.accountNumber})`,
              broker: data.broker || data.server.split('-')[0] || 'MT5 Broker',
              server: data.server,
              balance: parseFloat(data.initialBalance || 0),
              equity: parseFloat(data.initialBalance || 0),
              margin: 0.00,
              freeMargin: parseFloat(data.initialBalance || 0),
              floatingPnL: 0.00,
              status: 'active',
              lastSeen: null,
              latencyMs: null,
              riskSettings: {
                mode: data.mode || 'multiplier',
                multiplier: parseFloat(data.multiplier || 1.0),
                fixedLot: parseFloat(data.fixedLot || 0.10),
                equityRiskPercent: parseFloat(data.equityRiskPercent || 2.0),
                maxDrawdownPercent: parseFloat(data.maxDrawdownPercent || 5.0),
                maxSpreadPips: parseFloat(data.maxSpreadPips || 2.5),
                symbolMapping: data.symbolMapping || {}
              }
            };
            store.slaves.push(newSlave);
          } else {
            newSlave.riskSettings.mode = data.mode || newSlave.riskSettings.mode;
            newSlave.riskSettings.multiplier = parseFloat(data.multiplier || newSlave.riskSettings.multiplier);
            newSlave.server = data.server || newSlave.server;
          }
          store.roleAssignments[newSlave.accountNumber] = 'SLAVE';

          // If this account had already connected via the EA before being pre-registered here,
          // it would be sitting in the unassigned queue — clear it out now that it's classified.
          store.unassigned = store.unassigned.filter(a => a.accountNumber !== newSlave.accountNumber);

          store.executionLogs.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            event: 'SLAVE_REGISTERED',
            account: newSlave.accountNumber,
            details: `Real MT5 slave account ${newSlave.accountNumber} linked on server ${newSlave.server}`
          });

          updateRealStats();
          res.writeHead(201);
          return res.end(JSON.stringify({ success: true, slave: newSlave }));
        } catch (e) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    // PUT /api/accounts/slave/:id/status
    if (req.method === 'PUT' && pathname.includes('/status')) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const slaveId = pathname.split('/')[4];
          const data = JSON.parse(body || '{}');
          const slave = store.slaves.find(s => s.id === slaveId);

          if (!slave) {
            res.writeHead(404);
            return res.end(JSON.stringify({ error: 'Slave account not found' }));
          }

          slave.status = data.status || 'active';
          slave.lastSeen = new Date().toISOString();

          store.executionLogs.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            event: 'SLAVE_STATUS_CHANGED',
            account: slave.accountNumber,
            details: `Account ${slave.accountNumber} status set to ${slave.status.toUpperCase()}`
          });

          updateRealStats();
          res.writeHead(200);
          return res.end(JSON.stringify({ success: true, slave }));
        } catch (e) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Failed to update status' }));
        }
      });
      return;
    }

    // DELETE /api/accounts/slave/:id
    if (req.method === 'DELETE' && pathname.startsWith('/api/accounts/slave/')) {
      const slaveId = pathname.split('/')[4];
      const index = store.slaves.findIndex(s => s.id === slaveId);
      if (index !== -1) {
        const [removed] = store.slaves.splice(index, 1);
        delete store.roleAssignments[removed.accountNumber]; // EA reconnecting will land back in "unassigned"
        updateRealStats();
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, removedId: slaveId }));
      }
      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'Slave not found' }));
    }

    // GET /api/trades
    if (req.method === 'GET' && pathname === '/api/trades') {
      res.writeHead(200);
      return res.end(JSON.stringify({
        trades: store.trades,
        logs: store.executionLogs
      }));
    }

    // POST /api/trades/close-all
    if (req.method === 'POST' && pathname === '/api/trades/close-all') {
      store.slaves.forEach(s => {
        store.pendingEaCommands.push({
          id: Date.now(),
          targetAccount: s.accountNumber,
          action: 'CLOSE_ALL'
        });
      });

      store.executionLogs.unshift({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        event: 'EMERGENCY_CLOSE_ALL',
        details: `CLOSE ALL command dispatched to all connected MT5 EA terminals.`
      });

      updateRealStats();
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true, message: 'Close signals sent to all MT5 terminals' }));
    }

    // POST /api/ea/auto-install
    if (req.method === 'POST' && pathname === '/api/ea/auto-install') {
      // Auto-install can only ever find MT5 on the machine this Node process runs on. When the
      // server is hosted remotely (Railway, etc.), that's the container's own filesystem — never
      // the visitor's computer — so scanning for it there is meaningless and must not claim success.
      const remoteAddr = req.socket.remoteAddress || '';
      const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';

      if (!isLoopback) {
        const result = {
          success: false,
          message: 'Auto-Install only works when this dashboard runs on the same computer as your MT5 terminal. This server is hosted remotely, so it cannot reach your machine — use "Manual Download (.mq5)" instead and drag the file into your own MT5 MQL5/Experts folder.',
          installedPaths: []
        };
        res.writeHead(200);
        return res.end(JSON.stringify(result));
      }

      const result = installEA();

      store.executionLogs.unshift({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        event: 'EA_AUTO_INSTALLED',
        details: result.message
      });

      updateRealStats();
      res.writeHead(200);
      return res.end(JSON.stringify(result));
    }

    // POST /api/ea/sync (REAL MT5 EA Telemetry & Positions Intake)
    if (req.method === 'POST' && pathname === '/api/ea/sync') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          const accountNo = String(data.accountNumber);
          const assignedRole = store.roleAssignments[accountNo]; // dashboard is the source of truth, not the EA's own role input
          lastEaSyncAt = Date.now();

          if (!assignedRole) {
            // Newly connected account with no dashboard role assignment yet — surface it for the
            // user to classify, instead of guessing from whatever the EA happened to send.
            let pending = store.unassigned.find(a => a.accountNumber === accountNo);
            if (!pending) {
              pending = { accountNumber: accountNo, accountName: data.accountName || `MT5 Account (${accountNo})` };
              store.unassigned.push(pending);
            }
            pending.broker = data.broker || data.server;
            pending.server = data.server;
            pending.balance = parseFloat(data.balance || 0);
            pending.equity = parseFloat(data.equity || 0);
            pending.margin = parseFloat(data.margin || 0);
            pending.freeMargin = parseFloat(data.freeMargin || 0);
            pending.floatingPnL = parseFloat((pending.equity - pending.balance).toFixed(2));
            pending.lastSeen = new Date().toISOString();
            pending.latencyMs = typeof data.pingMs === 'number' ? data.pingMs : null;
            pending.eaReportedRole = data.role || null; // shown as a hint in the UI, not authoritative

            updateRealStats();
            res.writeHead(200);
            return res.end(JSON.stringify({ status: 'ok', masterTrades: store.trades, commands: [] }));
          }

          if (assignedRole === 'MASTER') {
            let master = store.masters.find(m => m.accountNumber === accountNo);
            if (!master) {
              master = {
                id: 'MST-' + accountNo,
                accountNumber: accountNo,
                accountName: data.accountName || `Master MT5 (${accountNo})`,
                broker: data.broker || data.server,
                server: data.server,
                balance: 0,
                equity: 0,
                margin: 0,
                freeMargin: 0,
                floatingPnL: 0,
                openPositions: 0,
                status: 'active',
                lastSeen: new Date().toISOString()
              };
              store.masters.push(master);
            }

            master.balance = parseFloat(data.balance || 0);
            master.equity = parseFloat(data.equity || 0);
            master.margin = parseFloat(data.margin || 0);
            master.freeMargin = parseFloat(data.freeMargin || 0);
            master.floatingPnL = parseFloat((master.equity - master.balance).toFixed(2));
            master.lastSeen = new Date().toISOString();
            if (typeof data.pingMs === 'number') master.latencyMs = data.pingMs;

            // Real win/loss counts computed by the EA from actual MT5 closed deal history
            if (data.closedStats && typeof data.closedStats.wins === 'number' && typeof data.closedStats.losses === 'number') {
              master.closedWins = data.closedStats.wins;
              master.closedLosses = data.closedStats.losses;
            }

            // Receive real MT5 open trades from Master EA
            if (Array.isArray(data.positions)) {
              store.trades = data.positions.map(pos => ({
                ticket: pos.ticket,
                masterAccountId: master.id,
                symbol: pos.symbol,
                type: pos.type,
                volume: parseFloat(pos.volume),
                openPrice: parseFloat(pos.openPrice),
                currentPrice: parseFloat(pos.currentPrice),
                sl: parseFloat(pos.sl || 0),
                tp: parseFloat(pos.tp || 0),
                pnl: parseFloat(pos.pnl || 0),
                copiedSlaves: store.slaves.map(s => ({
                  slaveId: s.id,
                  volume: s.riskSettings.mode === 'multiplier' ? pos.volume * s.riskSettings.multiplier : s.riskSettings.fixedLot,
                  status: s.status === 'active' ? 'synced' : 'paused'
                }))
              }));
              master.openPositions = store.trades.length;
            }
          } else {
            // Update Real Slave Account Telemetry
            let slave = store.slaves.find(s => s.accountNumber === accountNo);
            if (!slave) {
              slave = {
                id: 'SLV-' + accountNo,
                accountNumber: accountNo,
                accountName: data.accountName || `MT5 Slave (${accountNo})`,
                broker: data.broker || data.server,
                server: data.server,
                balance: 0,
                equity: 0,
                margin: 0,
                freeMargin: 0,
                floatingPnL: 0,
                status: 'active',
                lastSeen: new Date().toISOString(),
                latencyMs: typeof data.pingMs === 'number' ? data.pingMs : null,
                riskSettings: { mode: 'multiplier', multiplier: 1.0, fixedLot: 0.1, maxSpreadPips: 3.0 }
              };
              store.slaves.push(slave);
            }

            slave.balance = parseFloat(data.balance || 0);
            slave.equity = parseFloat(data.equity || 0);
            slave.margin = parseFloat(data.margin || 0);
            slave.freeMargin = parseFloat(data.freeMargin || 0);
            slave.floatingPnL = parseFloat((slave.equity - slave.balance).toFixed(2));
            slave.lastSeen = new Date().toISOString();
            if (typeof data.pingMs === 'number') slave.latencyMs = data.pingMs;
          }

          updateRealStats();

          // Get commands for this EA
          const myCommands = store.pendingEaCommands.filter(c => c.targetAccount === accountNo);
          store.pendingEaCommands = store.pendingEaCommands.filter(c => c.targetAccount !== accountNo);

          res.writeHead(200);
          return res.end(JSON.stringify({
            status: 'ok',
            masterTrades: store.trades,
            commands: myCommands
          }));
        } catch (e) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Telemetry error: ' + e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }

  // Static Asset Delivery
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  const extname = path.extname(filePath);
  let contentType = 'text/html';

  switch (extname) {
    case '.js': contentType = 'text/javascript'; break;
    case '.css': contentType = 'text/css'; break;
    case '.json': contentType = 'application/json'; break;
    case '.png': contentType = 'image/png'; break;
    case '.jpg': contentType = 'image/jpg'; break;
    case '.svg': contentType = 'image/svg+xml'; break;
    case '.mq5': contentType = 'text/plain'; break;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexContent) => {
          if (err2) {
            res.writeHead(500);
            return res.end('Error loading application');
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(indexContent, 'utf-8');
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Zenvest MT5 Copy Trading Real Engine Online`);
  console.log(` Local Server: http://localhost:${PORT}`);
  console.log(` SSE Stream:   http://localhost:${PORT}/api/stream`);
  console.log(`====================================================`);
});

// Re-evaluate EA online/offline status against the wall clock even when no new
// telemetry arrives, so a disconnected EA doesn't stay shown as "Online" forever.
setInterval(updateRealStats, 5000);
