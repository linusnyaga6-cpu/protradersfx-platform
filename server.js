const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const WebSocket = require('ws');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'dist', 'public');
const CANONICAL_ROBOTS = [
  'User-agent: *',
  'Allow: /',
  'Disallow: /sign-in',
  'Disallow: /sign-up',
  'Disallow: /account',
  'Disallow: /?view=',
  'Sitemap: https://protradersfx.com/sitemap.xml'
].join('\n') + '\n';
const CANONICAL_SITEMAP = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://protradersfx.com/</loc></url></urlset>\n';
const DERIV_CLIENT_ID = process.env.DERIV_CLIENT_ID || '';
const DERIV_PUBLIC_APP_ID = process.env.DERIV_PUBLIC_APP_ID || process.env.DERIV_APP_ID || '';
const DERIV_AFFILIATE_PARAM = process.env.DERIV_AFFILIATE_PARAM || 't';
const DERIV_AFFILIATE_TOKEN = process.env.DERIV_AFFILIATE_TOKEN || '';
const DERIV_AFFILIATE_ID = process.env.DERIV_AFFILIATE_ID || '';
const DERIV_CAMPAIGN = process.env.DERIV_CAMPAIGN || 'protraders-fx';
const DERIV_SCOPE = process.env.DERIV_SCOPE || 'trade account_manage';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DATA_FILE = process.env.VERCEL ? path.join('/tmp', 'protraders-fx-analytics.json') : path.join(__dirname, 'data', 'analytics.json');
// Read frontend assets explicitly so @vercel/node includes them in the function bundle.
const FRONTEND = { index: fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8') };
const CANONICAL_INDEX = FRONTEND.index;

if (!process.env.VERCEL) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ visitors: 0, registrations: 0, events: [] }, null, 2));
}

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { visitors: 0, registrations: 0, events: [] }; }
}
function writeData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch (error) { console.warn('[analytics] transient storage unavailable:', error.message); }
}
function base64url(value) { return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function encryptionKey() { return crypto.createHash('sha256').update(SESSION_SECRET).digest(); }
function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `${base64url(iv)}.${base64url(cipher.getAuthTag())}.${base64url(encrypted)}`;
}
function unseal(value) {
  const [iv, tag, data] = String(value || '').split('.');
  if (!iv || !tag || !data) throw new Error('Invalid session');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'));
}
function verifier() { return base64url(crypto.randomBytes(64)); }
function challenge(value) { return base64url(crypto.createHash('sha256').update(value).digest()); }
function getSession(req) {
  try {
    const session = unseal(req.cookies?.protraders_session);
    if (!session?.accessToken || Date.now() >= session.expiresAt) return null;
    return session;
  } catch { return null; }
}
function saveSession(res, session) {
  const maxAge = Math.max(60_000, Number(session.expiresAt || Date.now() + 3_600_000) - Date.now());
  res.cookie('protraders_session', seal(session), { httpOnly: true, secure: BASE_URL.startsWith('https://'), sameSite: 'lax', maxAge, path: '/' });
}
const OPTIONS_API_BASE = 'https://api.derivws.com/trading/v1/options';
async function optionsRequest(pathname, accessToken, init = {}) {
  const headers = { Authorization: 'Bearer ' + accessToken, Accept: 'application/json', ...(init.headers || {}) };
  const response = await fetch(OPTIONS_API_BASE + pathname, { ...init, headers });
  let body = null; try { body = await response.json(); } catch {}
  if (!response.ok) { const detail = body?.errors?.[0]?.message || body?.message || ('Options API request failed (' + response.status + ')'); const error = new Error(detail); error.code = 'OPTIONS_API_' + response.status; throw error; }
  return body?.data ?? body;
}
async function optionsAccounts(accessToken) {
  const rows = await optionsRequest('/accounts', accessToken);
  return (Array.isArray(rows) ? rows : []).map((account) => ({ account_id: account.account_id || '', loginid: account.loginid || account.account_id || '', currency: account.currency || 'USD', account_type: account.account_type || (account.is_virtual ? 'demo' : 'real'), is_virtual: account.account_type === 'demo' || Boolean(account.is_virtual), balance: Number(account.balance), token: accessToken })).filter((account) => account.account_id);
}
function accountIsDemo(account) { return Boolean(account?.is_virtual || account?.isVirtual || account?.account_type === 'demo' || /^VRT/i.test(String(account?.loginid || ''))); }
function accountSummary(account, balanceValue = null, balanceError = null) {
  const summary = { account_id: account.account_id || '', loginid: account.loginid || account.account_id || '', currency: account.currency || 'USD', is_virtual: accountIsDemo(account), balance: Number.isFinite(Number(balanceValue)) ? Number(balanceValue) : null };
  if (balanceError) summary.balanceError = 'Balance unavailable';
  return summary;
}
async function accountBalanceView(account, fallbackToken) {
  if (Number.isFinite(account.balance)) return accountSummary(account, account.balance, null);
  try { const response = await openDeriv(account.token || fallbackToken, { balance: 1 }); const value = response.balance || {}; return { ...accountSummary(account, Number(value.balance), null), loginid: value.loginid || account.loginid || account.account_id || '', currency: value.currency || account.currency || 'USD' }; }
  catch { return accountSummary(account, null, true); }
}
async function accountViews(session, accounts) { return Promise.all(accounts.map((account) => accountBalanceView(account, session.accessToken))); }
function normalizeAccounts(auth, fallbackToken) {
  const list = Array.isArray(auth?.account_list) ? auth.account_list : Array.isArray(auth?.accounts) ? auth.accounts : [];
  const accounts = list.map((account) => ({ loginid: account.loginid || account.account_id || '', currency: account.currency || auth.currency || 'USD', is_virtual: accountIsDemo(account), token: account.token || fallbackToken })).filter((account) => account.loginid || account.token);
  if (accounts.length) return accounts;
  return [{ loginid: auth?.loginid || '', currency: auth?.currency || 'USD', is_virtual: /^VRT/i.test(String(auth?.loginid || '')), token: fallbackToken }];
}
function safeReturnTo(value) { const target = String(value || '/workspace.html'); return target.startsWith('/') && !target.startsWith('//') ? target : '/workspace.html'; }
function withQuery(pathname, key, value) { const joiner = pathname.includes('?') ? '&' : '?'; return pathname + joiner + encodeURIComponent(key) + '=' + encodeURIComponent(value); }
function oauthUrl(mode, returnTo = '/workspace.html') {
  if (!DERIV_CLIENT_ID) throw new Error('DERIV_CLIENT_ID is not configured');
  const codeVerifier = verifier();
  const state = seal({ verifier: codeVerifier, mode, returnTo: safeReturnTo(returnTo), iat: Date.now() });
  const params = new URLSearchParams({ response_type: 'code', client_id: DERIV_CLIENT_ID, redirect_uri: BASE_URL + '/oauth/callback', scope: DERIV_SCOPE, state, code_challenge: challenge(codeVerifier), code_challenge_method: 'S256' });
  if (mode === 'signup') {
    if (!DERIV_AFFILIATE_TOKEN) throw new Error('Deriv signup attribution is not configured');
    params.set('prompt', 'registration'); params.set(DERIV_AFFILIATE_PARAM, DERIV_AFFILIATE_TOKEN); params.set('utm_campaign', DERIV_CAMPAIGN); params.set('utm_medium', 'affiliate');
    if (DERIV_AFFILIATE_ID) params.set('utm_source', DERIV_AFFILIATE_ID);
  }
  return 'https://auth.deriv.com/oauth2/auth?' + params.toString();
}
function openDeriv(accessToken, payload, authorizeOnly = false) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(DERIV_PUBLIC_APP_ID || '1089')}`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('Deriv request timeout')); }, 12_000);
    ws.on('open', () => ws.send(JSON.stringify({ authorize: accessToken })));
    ws.on('message', (raw) => {
      let data; try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data.error) { clearTimeout(timer); try { ws.close(); } catch {}; reject(new Error(data.error.message || 'Deriv API error')); return; }
      if (data.msg_type === 'authorize') {
        if (authorizeOnly) { clearTimeout(timer); try { ws.close(); } catch {}; resolve(data); return; }
        ws.send(JSON.stringify(payload)); return;
      }
      if (data.msg_type) { clearTimeout(timer); try { ws.close(); } catch {}; resolve(data); }
    });
    ws.on('error', (error) => { clearTimeout(timer); reject(error); });
    ws.on('close', () => clearTimeout(timer));
  });
}
function openDerivPublic(payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('Deriv market request timeout')); }, 10_000);
    ws.on('open', () => ws.send(JSON.stringify(payload)));
    ws.on('message', (raw) => {
      let data; try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data.error) { clearTimeout(timer); try { ws.close(); } catch {}; reject(new Error(data.error.message || 'Deriv market error')); return; }
      if (data.msg_type === 'tick' || data.msg_type === 'active_symbols') { clearTimeout(timer); try { ws.close(); } catch {}; resolve(data); }
    });
    ws.on('error', (error) => { clearTimeout(timer); reject(error); });
    ws.on('close', () => clearTimeout(timer));
  });
}
async function authorizeAccounts(session) {
  try { const accounts = await optionsAccounts(session.accessToken); if (accounts.length) { session.accounts = accounts; return accounts; } } catch (error) { console.warn('[deriv options accounts]', error.message); }
  const auth = await openDeriv(session.accessToken, null, true); session.accounts = normalizeAccounts(auth, session.accessToken); return session.accounts;
}
async function accountsFor(session) { if (Array.isArray(session.accounts) && session.accounts.length) return session.accounts; return authorizeAccounts(session); }
async function refreshAccounts(session) {
  try { const accounts = await optionsAccounts(session.accessToken); if (accounts.length) { session.accounts = accounts; return accounts; } } catch (error) { console.warn('[deriv options refresh]', error.message); }
  return accountsFor(session);
}
function openOptions(accessToken, account, payload) {
  return new Promise(async (resolve, reject) => {
    try {
      const otp = await optionsRequest('/accounts/' + encodeURIComponent(account.account_id) + '/otp', accessToken, { method: 'POST' });
      const ws = new WebSocket(otp?.url || '');
      const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error('Deriv trading connection timeout')); }, 15000);
      ws.on('open', () => ws.send(JSON.stringify(payload)));
      ws.on('message', (raw) => { let data; try { data = JSON.parse(raw.toString()); } catch { return; } if (data.error) { clearTimeout(timer); try { ws.close(); } catch {}; const error = new Error(data.error.message || 'Deriv trading error'); error.code = data.error.code || 'DERIV_TRADE_ERROR'; reject(error); return; } if (data.msg_type === 'proposal' || data.msg_type === 'buy') { clearTimeout(timer); try { ws.close(); } catch {}; resolve(data); } });
      ws.on('error', (error) => { clearTimeout(timer); reject(error); }); ws.on('close', () => clearTimeout(timer));
    } catch (error) { reject(error); }
  });
}
function selectedAccount(session, mode) {
  const accounts = Array.isArray(session.accounts) ? session.accounts : [];
  return accounts.find((account) => mode === 'demo' ? accountIsDemo(account) : !accountIsDemo(account)) || null;
}
async function requestForMode(session, mode, payload) {
  const accounts = await accountsFor(session);
  const account = selectedAccount(session, mode);
  if (!account) { const error = new Error(`No ${mode} account is linked to this Deriv login`); error.code = 'ACCOUNT_MODE_UNAVAILABLE'; throw error; }
  return { response: await openDeriv(account.token || session.accessToken, payload), account, accounts };
}

const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()) : [BASE_URL];
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], connectSrc: ["'self'", 'https://auth.deriv.com', 'https://api.derivws.com', 'wss://*.derivws.com', 'https://*.clerk.accounts.dev', 'https://clerk-telemetry.com'], scriptSrc: ["'self'", 'https://*.clerk.accounts.dev', 'https://challenges.cloudflare.com'], frameSrc: ["'self'", 'https://*.clerk.accounts.dev', 'https://challenges.cloudflare.com'], workerSrc: ["'self'", 'blob:'], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], imgSrc: ["'self'", 'data:', 'https:'], frameAncestors: ["'none'"] } }, referrerPolicy: { policy: 'strict-origin-when-cross-origin' } }));
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(cookieParser());
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 180, standardHeaders: true, legacyHeaders: false }));

app.get('/api/config', (req, res) => res.json({ configured: Boolean(DERIV_CLIENT_ID && DERIV_AFFILIATE_TOKEN), publicAppConfigured: Boolean(DERIV_PUBLIC_APP_ID), partnerParam: DERIV_AFFILIATE_PARAM, campaign: DERIV_CAMPAIGN }));
const PUBLIC_MARKET_SYMBOLS = new Set(['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD', 'frxUSDCAD', 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V']);
app.get('/api/market/tick', async (req, res) => {
  const symbol = String(req.query.symbol || 'frxEURUSD');
  if (!PUBLIC_MARKET_SYMBOLS.has(symbol)) return res.status(400).json({ error: 'Unsupported market symbol' });
  try {
    const tick = await openDerivPublic({ ticks: symbol });
    res.set('Cache-Control', 'no-store').json({ msg_type: 'tick', tick: tick.tick, server_time: tick.server_time });
  } catch (error) {
    res.status(502).json({ error: 'Market feed unavailable', message: error.message });
  }
});
app.post('/api/track', (req, res) => { const type = String(req.body?.type || 'page_view').slice(0, 40); const data = readData(); if (type === 'page_view') data.visitors++; data.events.push({ type, at: new Date().toISOString(), path: String(req.body?.path || '/').slice(0, 200) }); if (data.events.length > 5000) data.events = data.events.slice(-5000); writeData(data); res.status(204).end(); });
app.get('/api/analytics', (req, res) => { const session = getSession(req); if (!session) return res.status(401).json({ error: 'Owner activity requires a connected Deriv session' }); const data = readData(); const events = Array.isArray(data.events) ? data.events : []; const referralSignupStarts = events.filter((event) => event.type === 'referral_signup_started').length; const referralSignupCompletions = events.filter((event) => event.type === 'oauth_signup_success').length; res.json({ usersOnBoard: data.visitors || 0, siteVisits: data.visitors || 0, referralSignupStarts, referralSignupCompletions, confirmedReferrals: null, expectedCommission: null, commissionStatus: 'PENDING_DERIV_PARTNER_HUB', note: 'Signup completions show OAuth flows launched with the configured referral link. Deriv Partner Hub is required to confirm qualifying referrals and commission.' }); });
app.get('/api/deriv/login', (req, res) => { try { res.redirect(oauthUrl('login', req.query.returnTo)); } catch (error) { res.status(503).json({ error: error.message }); } });
app.get('/api/deriv/signup', (req, res) => { try { const data = readData(); data.events.push({ type: 'referral_signup_started', at: new Date().toISOString() }); writeData(data); res.redirect(oauthUrl('signup', req.query.returnTo)); } catch (error) { res.status(503).json({ error: error.message }); } });
app.get('/oauth/callback', async (req, res) => {
  let state = null;
  try { state = unseal(req.query.state); } catch {}
  const returnTo = safeReturnTo(state?.returnTo);
  try {
    if (req.query.error) return res.redirect(withQuery(returnTo, 'oauth_error', String(req.query.error)));
    if (!state?.verifier || !['login', 'signup'].includes(state.mode) || Date.now() - state.iat > 600_000) throw new Error('Invalid or expired OAuth state');
    if (!req.query.code) throw new Error('Missing OAuth authorization code');
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: DERIV_CLIENT_ID, code: String(req.query.code), code_verifier: state.verifier, redirect_uri: BASE_URL + '/oauth/callback' });
    const tokenResponse = await fetch('https://auth.deriv.com/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!tokenResponse.ok) throw new Error('Token exchange failed (' + tokenResponse.status + ')');
    const token = await tokenResponse.json();
    if (!token.access_token) throw new Error('No access token returned');
    const session = { accessToken: token.access_token, refreshToken: token.refresh_token || null, expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000, accounts: [], activeMode: 'demo' };
    saveSession(res, session);
    const data = readData(); data.events.push({ type: state.mode === 'signup' ? 'oauth_signup_success' : 'oauth_login_success', at: new Date().toISOString() }); if (state.mode === 'signup') { data.registrations = (data.registrations || 0) + 1; data.events.push({ type: 'registration_complete', at: new Date().toISOString() }); } writeData(data);
    res.redirect(withQuery(returnTo, 'connected', '1'));
  } catch (error) { console.error(error.message); res.redirect(withQuery(returnTo, 'oauth_error', 'oauth_failed')); }
});
app.get('/api/session', (req, res) => { const session = getSession(req); if (!session) return res.json({ authenticated: false }); res.json({ authenticated: true, expiresAt: session.expiresAt, activeMode: session.activeMode || 'demo' }); });
app.post('/api/logout', (req, res) => { res.clearCookie('protraders_session', { httpOnly: true, secure: BASE_URL.startsWith('https://'), sameSite: 'lax', path: '/' }); res.status(204).end(); });
app.get('/api/accounts', async (req, res) => { const session = getSession(req); if (!session) return res.status(401).json({ authenticated: false }); try { const accounts = await refreshAccounts(session); const views = await accountViews(session, accounts); saveSession(res, session); res.json({ authenticated: true, accounts: views, activeMode: session.activeMode || 'demo' }); } catch (error) { res.status(502).json({ error: error.code || 'Account list unavailable', message: error.message }); } });
app.post('/api/account/switch', async (req, res) => { const session = getSession(req); if (!session) return res.status(401).json({ authenticated: false }); const mode = req.body?.mode === 'real' ? 'real' : 'demo'; try { const accounts = await refreshAccounts(session); const account = selectedAccount(session, mode); if (!account) return res.status(409).json({ error: 'ACCOUNT_MODE_UNAVAILABLE', message: 'No ' + mode + ' account is linked to this Deriv login.' }); session.activeMode = mode; const views = await accountViews(session, accounts); const current = views.find((item) => item.account_id === account.account_id) || accountSummary(account, account.balance); saveSession(res, session); res.json({ authenticated: true, mode, loginid: current.loginid, currency: current.currency, balance: current.balance, accounts: views }); } catch (error) { res.status(502).json({ error: error.code || 'Account switch failed', message: error.message }); } });
app.get('/api/account', async (req, res) => { const session = getSession(req); if (!session) return res.status(401).json({ authenticated: false }); const mode = req.query.mode === 'real' ? 'real' : req.query.mode === 'demo' ? 'demo' : session.activeMode || 'demo'; try { const accounts = await refreshAccounts(session); const account = selectedAccount(session, mode); if (!account) { const error = new Error('No ' + mode + ' account is linked to this Deriv login'); error.code = 'ACCOUNT_MODE_UNAVAILABLE'; throw error; } const current = accountSummary(account, account.balance); session.activeMode = mode; saveSession(res, session); res.json({ authenticated: true, mode, balance: current.balance, currency: current.currency, loginid: current.loginid, account: current, openPnl: 0, accounts: await accountViews(session, accounts) }); } catch (error) { res.status(error.code === 'ACCOUNT_MODE_UNAVAILABLE' ? 409 : 502).json({ error: error.code || 'Account data unavailable', message: error.message }); } });
const reviewTrade = (req, res) => { const session = getSession(req); if (!session) return res.status(401).json({ error: 'Not authenticated' }); const mode = req.body?.mode === 'real' ? 'real' : 'demo'; const symbol = String(req.body?.symbol || 'R_100'); const contractType = ['CALL', 'PUT'].includes(req.body?.contract_type) ? req.body.contract_type : null; const stake = Number(req.body?.stake); const duration = Number(req.body?.duration); if (!contractType || !/^([A-Z0-9_]+|frx[A-Z]+)$/.test(symbol) || !Number.isFinite(stake) || stake <= 0 || !Number.isFinite(duration) || duration < 1 || duration > 3600) return res.status(400).json({ error: 'Invalid trade parameters' }); res.json({ ok: true, mode, symbol, contractType, stake, duration, execution: 'proposal_only', status: 'pending_review', message: 'Trade proposal created for review. No Deriv contract was purchased.' }); };
app.post('/api/trades', reviewTrade);
app.post('/api/trades/proposal', reviewTrade);app.post('/api/bot', async (req, res) => { const session = getSession(req); if (!session) return res.status(401).json({ error: 'Not authenticated' }); const action = req.body?.action === 'start' ? 'start' : 'stop'; res.json({ ok: true, message: action === 'start' ? 'Free bot interface started in controlled mode. Live bot execution remains disabled until the bot adapter is separately tested.' : 'Free bot stopped.', execution: 'interface_only' }); });
app.get('/api/preflight', (req, res) => res.json({ productionBaseUrl: BASE_URL, redirectUri: `${BASE_URL}/oauth/callback`, https: BASE_URL.startsWith('https://'), oauthClientConfigured: Boolean(DERIV_CLIENT_ID), partnerTrackingConfigured: Boolean(DERIV_AFFILIATE_TOKEN), sessionSecretConfigured: Boolean(process.env.SESSION_SECRET), readyForControlledLiveTest: Boolean(BASE_URL.startsWith('https://') && DERIV_CLIENT_ID && DERIV_AFFILIATE_TOKEN && process.env.SESSION_SECRET) }));
app.get('/health', (req, res) => res.json({ ok: true, service: 'protraders-fx', time: new Date().toISOString() }));
app.get('/robots.txt', (req, res) => res.type('text/plain').send(CANONICAL_ROBOTS));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(CANONICAL_SITEMAP));
app.get('/app-config.js', (req, res) => res.type('application/javascript').send('window.PROTRADERS_PUBLIC_APP_ID=' + JSON.stringify(DERIV_PUBLIC_APP_ID) + ';'));
app.get('/favicon.ico', (req, res) => res.type('image/svg+xml').send(fs.readFileSync(path.join(PUBLIC_DIR, 'favicon.svg'), 'utf8')));
app.get('/workspace', (req, res) => res.type('html').send(CANONICAL_INDEX));
app.get('/workspace.html', (req, res) => res.type('html').send(CANONICAL_INDEX));
for (const page of ['marketplace', 'course', 'signals', 'manual', 'builder']) app.get(`/${page}`, (req, res) => res.type('html').send(CANONICAL_INDEX));
app.get('/', (req, res) => res.type('html').send(CANONICAL_INDEX));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('*', (req, res) => res.type('html').send(CANONICAL_INDEX));
app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: 'Internal server error' }); });

module.exports = app;
if (!process.env.VERCEL && require.main === module) app.listen(PORT, () => console.log(`[PROTRADERS FX] running on ${BASE_URL}`));
