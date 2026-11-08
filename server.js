// 沐藏料理所：訂位（含席次管理）+ LINE Pay 訂金 + 後台
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const { LINEPAY_CHANNEL_ID, LINEPAY_CHANNEL_SECRET, BASE_URL, ADMIN_PASSWORD,
  LINEPAY_ENV = 'sandbox', LINE_OA_ID = '@371oexcl' } = process.env;
const LP_HOST = LINEPAY_ENV === 'production' ? 'https://api-pay.line.me' : 'https://sandbox-api-pay.line.me';
const DEPOSIT = 1000, CAP = 8, HOLD_MS = 15 * 60 * 1000;
const MSG_GROUP = '8 位以上團體訂位，請來電聯繫沐藏料理所，由專人協助安排。';
const MSG_OTHER = '此日期或時段不在線上開放範圍。若您希望預約其他用餐時段，請透過官方 LINE（https://lin.ee/pOnRuXSY）或電話 0983-629-986 聯繫沐藏料理所，我們將由專人協助安排。';
const STATUS = ['inquiry', 'pending', 'paid', 'cancelled', 'failed'];

const app = express();
app.use(express.json({ limit: '20kb' }));

// ---- 儲存（Supabase / PostgreSQL）----
const { Pool } = require('pg');
const E = process.env;
const T = v => String(v || '').trim();
// 兩種設定方式擇一：DB_HOST / DB_USER / DB_PASSWORD（建議，不怕密碼有特殊字元），或 DATABASE_URL
if (!E.DB_HOST && !E.DATABASE_URL) { console.error('缺少資料庫設定：請設定 DB_HOST、DB_USER、DB_PASSWORD（或 DATABASE_URL）'); process.exit(1); }
const pool = new Pool(Object.assign(
  E.DB_HOST
    ? { host: T(E.DB_HOST), port: Number(T(E.DB_PORT)) || 5432, user: T(E.DB_USER), password: E.DB_PASSWORD, database: T(E.DB_NAME) || 'postgres' }
    : { connectionString: T(E.DATABASE_URL) },
  { ssl: { rejectUnauthorized: false }, max: 5 }));
const ready = pool.query('create table if not exists reservations (id text primary key, data jsonb not null, created_at timestamptz default now())')
  .then(() => pool.query('create table if not exists sales (id text primary key, data jsonb not null, created_at timestamptz default now())'));
async function load(c = pool) { const r = await c.query('select data from reservations'); return r.rows.map(x => x.data); }
async function put(r, c = pool) { await c.query('insert into reservations (id, data) values ($1, $2) on conflict (id) do update set data = $2', [r.id, r]); }
async function update(id, fn) {
  const q = await pool.query('select data from reservations where id = $1', [id]);
  if (!q.rows.length) return null;
  const d = q.rows[0].data; fn(d); await put(d); return d;
}
// 交易 + 鎖：同一時間只有一個請求能檢查並寫入席次，避免超收
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('begin'); await c.query('select pg_advisory_xact_lock(7001)'); const out = await fn(c); await c.query('commit'); return out; }
  catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: '系統忙碌，請稍後再試' }); });

// ---- 時段與席次 ----
const tw = (addDays = 0) => new Date(Date.now() + 8 * 3600e3 + addDays * 86400e3).toISOString().slice(0, 10);
function validDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T00:00:00Z')); }
function slotsFor(date) {
  if (!validDate(date)) return [];
  const w = new Date(date + 'T00:00:00Z').getUTCDay();
  if (w >= 3 && w <= 5) return ['12:00', '18:00'];            // 週三至週五
  if (w === 6 || w === 0) return ['11:30', '13:30', '18:00', '20:00']; // 週六、日
  return [];                                                   // 週一、週二不開放
}
// 佔用席次：已付款，或待付款且（人工建立 / 15 分鐘內）
function holds(r) { return r.status === 'paid' || (r.status === 'pending' && (r.manual || Date.now() - new Date(r.created) < HOLD_MS)); }
function occupied(list, date, time, exceptId) {
  return list.filter(r => r.date === date && r.time === time && r.id !== exceptId && holds(r)).reduce((a, r) => a + r.people, 0);
}
app.get('/api/slots', wrap(async (req, res) => {
  const date = String(req.query.date || '');
  const list = await load();
  const slots = slotsFor(date).map(t => ({ time: t, remaining: Math.max(0, CAP - occupied(list, date, t)) }));
  res.json({ date, cap: CAP, open: date >= tw(1) && slots.length > 0, tooSoon: validDate(date) && date < tw(1), slots });
}));

// ---- LINE Pay ----
async function linepay(uri, body) {
  const nonce = crypto.randomUUID(), json = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', LINEPAY_CHANNEL_SECRET).update(LINEPAY_CHANNEL_SECRET + uri + json + nonce).digest('base64');
  const res = await fetch(LP_HOST + uri, { method: 'POST', body: json, headers: {
    'Content-Type': 'application/json', 'X-LINE-ChannelId': LINEPAY_CHANNEL_ID,
    'X-LINE-Authorization-Nonce': nonce, 'X-LINE-Authorization': sig } });
  return res.json();
}

// ---- 管理員驗證 ----
function auth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('尚未設定 ADMIN_PASSWORD');
  const h = req.headers.authorization || '';
  const pw = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
  const a = crypto.createHash('sha256').update(pw).digest(), b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="muzang"').status(401).send('需要登入');
}

const page = f => (req, res) => res.sendFile(path.join(__dirname, f));
app.get('/', page('index.html'));
app.get('/pos.html', auth, page('pos.html'));
app.get('/admin', auth, page('admin.html'));
app.get('/sales', auth, page('sales.html'));

// ---- 客人訂位資料 ----
const clean = s => String(s || '').trim().slice(0, 200);
function build(b, source, status) {
  const people = Number(b.c);
  const unit = /1,880/.test(b.s) ? 1880 : /2,000/.test(b.s) ? 2000 : 0;
  return { id: 'MZ' + Date.now() + crypto.randomInt(100, 999), token: crypto.randomBytes(8).toString('hex'),
    name: clean(b.n), phone: clean(b.p), date: clean(b.d), time: clean(b.t), people,
    pkg: clean(b.s), allergy: clean(b.m), purpose: clean(b.o), note: clean(b.x),
    price: unit * people, amount: (Number.isInteger(people) ? people : 0) * DEPOSIT, status,
    created: new Date().toISOString(), paidAt: '', handler: '', contactDate: tw(), source, manual: false };
}
function check(r) {
  if (!r.name || !r.phone) return '請完整填寫姓名與電話';
  if (!validDate(r.date)) return '請選擇日期';
  if (!Number.isInteger(r.people) || r.people < 1) return '請填寫人數';
  if (r.people > CAP) return MSG_GROUP;
  if (r.date < tw(1)) return '請至少提前一日預約';
  if (!slotsFor(r.date).includes(r.time)) return MSG_OTHER;
  return '';
}

// 網站訂位 + LINE Pay 訂金
app.post('/api/reserve', wrap(async (req, res) => {
  if (!LINEPAY_CHANNEL_ID || !LINEPAY_CHANNEL_SECRET || !BASE_URL) return res.status(503).json({ error: '付款功能尚未設定完成' });
  const r = build(req.body || {}, '網站訂位', 'pending');
  const err = check(r);
  if (err) return res.status(400).json({ error: err });
  // 檢查席次並保留（交易內完成，避免超收）
  const full = await tx(async c => {
    const rem = CAP - occupied(await load(c), r.date, r.time);
    if (rem <= 0) return '該時段已額滿，請選擇其他時段';
    if (r.people > rem) return '該時段僅剩 ' + rem + ' 位，請調整人數或選擇其他時段';
    await put(r, c); return '';
  });
  if (full) return res.status(409).json({ error: full });
  const out = await linepay('/v3/payments/request', {
    amount: r.amount, currency: 'TWD', orderId: r.id,
    packages: [{ id: r.id, amount: r.amount, products: [{ name: '沐藏料理所 訂位訂金', quantity: r.people, price: DEPOSIT }] }],
    redirectUrls: { confirmUrl: BASE_URL + '/linepay/confirm', cancelUrl: BASE_URL + '/linepay/cancel?orderId=' + r.id },
  });
  if (out.returnCode !== '0000') {
    console.error('LINE Pay request failed', out.returnCode, out.returnMessage);
    await update(r.id, x => { x.status = 'failed'; });
    return res.status(502).json({ error: '建立付款失敗（' + out.returnCode + '），請稍後再試或改用官方 LINE 聯繫' });
  }
  await update(r.id, x => { x.transactionId = String(out.info.transactionId); });
  res.json({ url: out.info.paymentUrl.web });
}));

// 「傳送訂位資料至官方 LINE」：留一筆洽詢紀錄（不佔席次）
app.post('/api/inquiry', wrap(async (req, res) => {
  const r = build(req.body || {}, '官網表單→官方LINE', 'inquiry');
  if (!r.name || !r.phone || !validDate(r.date)) return res.status(400).json({ error: '資料不完整' });
  if (!Number.isInteger(r.people) || r.people < 1 || r.people > 50) return res.status(400).json({ error: '人數錯誤' });
  await put(r); res.json({ ok: true });
}));

app.get('/linepay/confirm', async (req, res) => {
  const { orderId, transactionId } = req.query;
  const list = await load().catch(() => []);
  const r = list.find(x => x.id === orderId);
  if (!r || String(r.transactionId) !== String(transactionId)) return res.redirect('/result?s=err');
  if (r.status === 'paid') return res.redirect('/result?s=ok&o=' + r.id + '&k=' + r.token);
  // 保留逾時後才付款：確認席次還夠，否則不扣款
  if (!holds(r) && CAP - occupied(list, r.date, r.time, r.id) < r.people) {
    await update(r.id, x => { x.status = 'failed'; });
    return res.redirect('/result?s=full');
  }
  try {
    const out = await linepay(`/v3/payments/${transactionId}/confirm`, { amount: r.amount, currency: 'TWD' });
    if (out.returnCode === '0000') {
      await update(r.id, x => { x.status = 'paid'; x.paidAt = new Date().toISOString(); });
      return res.redirect('/result?s=ok&o=' + r.id + '&k=' + r.token);
    }
    console.error('LINE Pay confirm failed', out.returnCode, out.returnMessage);
    await update(r.id, x => { x.status = 'failed'; });
  } catch (e) { console.error(e); }
  res.redirect('/result?s=err');
});
app.get('/linepay/cancel', wrap(async (req, res) => {
  await update(String(req.query.orderId), x => { if (x.status === 'pending') x.status = 'cancelled'; });
  res.redirect('/result?s=cancel');
}));

function summary(r, title) {
  return [title, '訂位人：' + r.name, '電話：' + r.phone, '日期：' + r.date + ' ' + r.time, '人數：' + r.people + '位',
    '套餐：' + r.pkg, '忌口或過敏：' + (r.allergy || '無'), '餐敘目的：' + r.purpose, '其他備註：' + (r.note || '無'),
    '訂金：$' + r.amount.toLocaleString(), '編號：' + r.id].join('\n');
}
app.get('/result', wrap(async (req, res) => {
  const s = req.query.s;
  const r = (await load()).find(x => x.id === req.query.o && x.token === req.query.k);
  const t = { ok: ['訂金已收到', '席位已為您保留，期待與您相聚。訂位編號：' + String(req.query.o || '').replace(/[^\w]/g, '')],
    cancel: ['已取消付款', '訂位尚未成立，如需訂位請重新操作。'],
    full: ['該時段席位已被預訂', '本次付款未成立（未扣款），請回訂位頁重新選擇時段。'],
    err: ['付款未完成', '若已被扣款請聯繫官方 LINE，我們會協助處理。'] }[s] || ['', ''];
  let btn = '';
  if (s === 'ok' && r) {
    const msg = summary(r, '【沐藏料理所 訂位確認】已付訂金');
    btn = `<p><b>最後一步：請按下方按鈕，把訂位資料傳送給官方 LINE，我們收到後會與您確認。</b></p><p><a href="https://line.me/R/oaMessage/${encodeURIComponent(LINE_OA_ID)}/?${encodeURIComponent(msg)}" style="display:inline-block;padding:14px 22px;background:#06a050;color:#fff;border-radius:10px;text-decoration:none">傳送訂位確認給官方 LINE</a></p>`;
  }
  res.send(`<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>沐藏料理所</title>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:12vh auto;padding:20px;text-align:center;line-height:1.7">
<h2>${t[0]}</h2><p>${t[1]}</p>${btn}
<p><a href="https://line.me/R/ti/p/${encodeURIComponent(LINE_OA_ID)}">返回官方 LINE</a></p>
<p style="color:#888">預約專線 0983-629-986</p></body>`);
}));

// ---- 後台 API ----
const FIELDS = ['name', 'phone', 'date', 'time', 'people', 'price', 'note', 'allergy', 'purpose', 'pkg', 'status', 'paidAt', 'handler', 'contactDate', 'source'];
function applyFields(r, b) {
  FIELDS.forEach(k => { if (b[k] !== undefined) r[k] = b[k]; });
  ['name', 'phone', 'date', 'time', 'note', 'allergy', 'purpose', 'pkg', 'paidAt', 'handler', 'contactDate', 'source'].forEach(k => { r[k] = String(r[k] || '').slice(0, 300); });
  r.people = Math.round(Number(r.people)); r.price = Math.max(0, Number(r.price) || 0);
  r.amount = (r.people || 0) * DEPOSIT;
}
function adminCheck(r, list, force) {
  if (!r.name) return [400, '請填寫訂位人'];
  if (!validDate(r.date) || !/^\d{2}:\d{2}$/.test(r.time)) return [400, '日期或時間格式錯誤'];
  if (!Number.isInteger(r.people) || r.people < 1 || r.people > 50) return [400, '人數錯誤'];
  if (!STATUS.includes(r.status)) return [400, '狀態錯誤'];
  if (holds(r) && slotsFor(r.date).includes(r.time)) {
    const rem = CAP - occupied(list, r.date, r.time, r.id);
    if (r.people > rem && !force) return [409, r.date + ' ' + r.time + ' 場剩餘 ' + Math.max(0, rem) + ' 位，此筆 ' + r.people + ' 位將超過 ' + CAP + ' 位上限。仍要儲存嗎？'];
  }
  return null;
}
app.get('/api/admin/reservations', auth, wrap(async (req, res) => res.json((await load()).reverse())));
app.post('/api/admin/reservations', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const r = { id: 'MZ' + Date.now() + crypto.randomInt(100, 999), token: crypto.randomBytes(8).toString('hex'), created: new Date().toISOString(),
    manual: true, status: 'pending', amount: 0, paidAt: '', handler: '', contactDate: tw(), source: '', pkg: '', purpose: '', allergy: '', note: '', price: 0 };
  applyFields(r, b);
  if (r.status === 'paid' && !r.paidAt) r.paidAt = new Date().toISOString();
  const out = await tx(async c => {
    const e = adminCheck(r, await load(c), b.force); if (e) return e;
    await put(r, c); return null;
  });
  if (out) return res.status(out[0]).json({ error: out[1] });
  res.json(r);
}));
app.put('/api/admin/reservations/:id', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await tx(async c => {
    const list = await load(c), r = list.find(x => x.id === req.params.id);
    if (!r) return [404, 'not found'];
    const was = r.status;
    applyFields(r, b);
    if (r.status === 'paid' && !r.paidAt) r.paidAt = new Date().toISOString();
    if (['pending', 'paid'].includes(r.status) && was === 'inquiry') r.manual = true;
    const e = adminCheck(r, list, b.force); if (e) return e;
    await put(r, c); return r;
  });
  if (Array.isArray(out)) return res.status(out[0]).json({ error: out[1] });
  res.json(out);
}));

// ---- POS 銷售紀錄（存進 Supabase）----
const n0 = v => Math.round(Number(v) || 0);
app.post('/api/pos/sales', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items.slice(0, 50).map(i => ({ n: String(i.n || '').slice(0, 100), p: Math.max(0, n0(i.p)), q: Math.max(1, n0(i.q)) })) : [];
  if (!items.length) return res.status(400).json({ error: '沒有品項' });
  const a = b.adj || {};
  let at = new Date(b.at);
  if (isNaN(at) || at.getTime() > Date.now() + 36e5 || at.getTime() < Date.now() - 90 * 864e5) at = new Date();
  const loc = new Date(at.getTime() + 8 * 3600e3).toISOString();
  const sub = items.reduce((x, i) => x + i.p * i.q, 0);
  const sale = { id: String(b.id || 'S' + Date.now() + crypto.randomInt(100, 999)).replace(/[^\w-]/g, '').slice(0, 40),
    at: at.toISOString(), date: loc.slice(0, 10), time: loc.slice(11, 16), items, sub,
    svc: n0(a.svc), d9: Math.min(0, n0(a.d9)), cp: Math.min(0, n0(a.cp)), bs: Math.min(0, n0(a.bs)), pay: String(b.pay || '').slice(0, 20) };
  sale.total = Math.max(0, sub + sale.svc + sale.d9 + sale.cp + sale.bs);
  await pool.query('insert into sales (id, data) values ($1, $2) on conflict (id) do nothing', [sale.id, sale]);
  res.json({ ok: true, id: sale.id });
}));
app.get('/api/pos/sales', auth, wrap(async (req, res) => {
  const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const from = ok(req.query.from) ? req.query.from : tw(), to = ok(req.query.to) ? req.query.to : tw();
  const r = await pool.query("select data from sales where data->>'date' >= $1 and data->>'date' <= $2 order by data->>'at' desc limit 3000", [from, to]);
  res.json(r.rows.map(x => x.data));
}));
app.delete('/api/pos/sales/:id', auth, wrap(async (req, res) => {
  const r = await pool.query('delete from sales where id = $1', [req.params.id]);
  res.json({ deleted: r.rowCount });
}));

app.delete('/api/admin/reservations/:id', auth, wrap(async (req, res) => {
  const r = await pool.query('delete from reservations where id = $1', [req.params.id]);
  res.json({ deleted: r.rowCount });
}));

ready.then(() => app.listen(process.env.PORT || 3000, () => console.log('muzang up, LINE Pay env:', LINEPAY_ENV)))
  .catch(e => { console.error('資料庫連線失敗', e.message, '| 使用者:', pool.options.user, '| 主機:', pool.options.host); process.exit(1); });
