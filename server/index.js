import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import { pool, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const searchLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const cookieOptions = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE !== 'false',
  sameSite: 'lax',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000
};
function makeToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d', issuer: 'stranger-chat' });
}
function requireAuth(req, res, next) {
  try {
    const token = req.cookies.sc_session;
    if (!token) return res.status(401).json({ error: 'Please sign in.' });
    req.user = jwt.verify(token, JWT_SECRET, { issuer: 'stranger-chat' });
    next();
  } catch { return res.status(401).json({ error: 'Session expired. Please sign in again.' }); }
}

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Password must be 10–128 characters.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email', [email, passwordHash]);
    res.cookie('sc_session', makeToken(rows[0]), cookieOptions).status(201).json({ user: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' });
    console.error('register error', e.message); res.status(500).json({ error: 'Could not create account.' });
  }
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT id,email,password_hash FROM users WHERE LOWER(email)=LOWER($1)', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Incorrect email or password.' });
  res.cookie('sc_session', makeToken(user), cookieOptions).json({ user: { id: user.id, email: user.email } });
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: { id: req.user.sub, email: req.user.email } }));
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('sc_session', { httpOnly: true, secure: cookieOptions.secure, sameSite: 'lax', path: '/' }).json({ ok: true });
});

// Email lookup returns only a matching account. No chat content is accepted or stored here.
app.get('/api/users/lookup', requireAuth, searchLimiter, async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (email === String(req.user.email).toLowerCase()) return res.status(400).json({ error: 'That is your own account.' });
  const { rows } = await pool.query('SELECT id,email FROM users WHERE LOWER(email)=LOWER($1)', [email]);
  if (!rows[0]) return res.status(404).json({ error: 'No account found with that email.' });
  res.json({ user: rows[0], online: onlineUsers.has(rows[0].id) });
});
app.get('/api/users/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id,email FROM users WHERE id=$1', [req.params.id]);
  if (!rows[0] || rows[0].id === req.user.sub) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: rows[0], online: onlineUsers.has(rows[0].id) });
});
app.get('/api/ice', requireAuth, (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({ urls: process.env.TURN_URLS.split(',').map(s => s.trim()), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.set('Cache-Control', 'no-store').json({ iceServers });
});

// Presence is in memory only. It resets on server restart and is not persisted.
const onlineUsers = new Map(); // userId -> Set<WebSocket>
function send(ws, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function addOnline(userId, ws) {
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  const set = onlineUsers.get(userId); const wasOnline = set.size > 0; set.add(ws);
  if (!wasOnline) broadcastPresence(userId, true);
}
function removeOnline(userId, ws) {
  const set = onlineUsers.get(userId); if (!set) return;
  set.delete(ws);
  if (!set.size) { onlineUsers.delete(userId); broadcastPresence(userId, false); }
}
function broadcastPresence(userId, online) {
  for (const sockets of onlineUsers.values()) for (const socket of sockets) send(socket, { type: 'presence', userId, online });
}
function socketFor(userId) { return onlineUsers.get(userId)?.values().next().value; }
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws') return socket.destroy();
  const cookies = Object.fromEntries((request.headers.cookie || '').split(';').map(v => v.trim().split(/=(.*)/s).slice(0,2)).filter(v => v.length === 2));
  try {
    const claims = jwt.verify(cookies.sc_session, JWT_SECRET, { issuer: 'stranger-chat' });
    wss.handleUpgrade(request, socket, head, ws => { ws.userId = claims.sub; wss.emit('connection', ws); });
  } catch { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); }
});
wss.on('connection', ws => {
  const userId = ws.userId; addOnline(userId, ws);
  send(ws, { type: 'ready', onlineUserIds: [...onlineUsers.keys()] });
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || !['call','offer','answer','ice','hangup'].includes(msg.type)) return;
    if (typeof msg.to !== 'string' || msg.to === userId) return;
    const target = socketFor(msg.to);
    if (!target) return send(ws, { type: 'peer-offline', userId: msg.to });
    // Relay only signaling metadata; the server never receives DataChannel chat messages.
    const safe = { type: msg.type, from: userId };
    if (msg.type === 'offer' || msg.type === 'answer') safe.description = msg.description;
    if (msg.type === 'ice') safe.candidate = msg.candidate;
    send(target, safe);
  });
  ws.on('close', () => removeOnline(userId, ws));
  ws.on('error', () => removeOnline(userId, ws));
});

await initDb();
server.listen(PORT, '0.0.0.0', () => console.log(`Stranger Chat listening on ${PORT}`));
