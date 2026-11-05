// 沐藏料理所：訂位 + LINE Pay 訂金後端
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  LINEPAY_CHANNEL_ID, LINEPAY_CHANNEL_SECRET, BASE_URL, ADMIN_PASSWORD,
  LINEPAY_ENV = 'sandbox', LINE_OA_ID = '@371oexcl',
  LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_ID, LINE_CHANNEL_SECRET, OWNER_LINE_IDS = '',
} = process.env;
const LP_HOST = LINEPAY_ENV === 'production' ? 'https://api-pay.line.me' : 'https://sandbox-api-pay.line.me';
const DEPOSIT = 1000;
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const app = express();
app.use(express.json({ limit: '20kb' }));

// ---- 簡易儲存（JSON 檔）----
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; } }
function save(list) { fs.writeFileSync(FILE + '.tmp', JSON.stringify(list)); fs.renameSync(FILE + '.tmp', FILE); }
function update(id, fn) { const l = load(); const r = l.find(x => x.id === id); if (r) { fn(r); save(l); } return r; }

// ---- LINE Pay API v3 ----
async function linepay(uri, body) {
  const nonce = crypto.randomUUID();
  const json = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', LINEPAY_CHANNEL_SECRET).update(LINEPAY_CHANNEL_SECRET + uri + json + nonce).digest('base64');
  const res = await fetch(LP_HOST + uri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LINE-ChannelId': LINEPAY_CHANNEL_ID,
      'X-LINE-Authorization-Nonce': nonce,
      'X-LINE-Authorization': sig,
    },
    body: json,
  });
  return res.json();
}

// ---- 通知店家（LINE Messaging API push）----
function summary(r, title) {
  return [title, '姓名：' + r.name, '電話：' + r.phone, '日期：' + r.date + ' ' + r.time, '人數：' + r.people + '位',
    '套餐：' + r.pkg, '忌口或過敏：' + (r.allergy || '無'), '餐敘目的：' + r.purpose, '其他備註：' + (r.note || '無'),
    '訂金：$' + r.amount.toLocaleString(), '編號：' + r.id].join('\n');
}
async function lineToken() {
  if (LINE_CHANNEL_ACCESS_TOKEN) return LINE_CHANNEL_ACCESS_TOKEN;
  if (!LINE_CHANNEL_ID || !LINE_CHANNEL_SECRET) return null;
  try {
    const res = await fetch('https://api.line.me/oauth2/v3/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: LINE_CHANNEL_ID, client_secret: LINE_CHANNEL_SECRET }),
    });
    return (await res.json()).access_token || null;
  } catch (e) { console.error('LINE token error', e); return null; }
}
async function notify(text) {
  const token = await lineToken();
  if (!token) return;
  for (const to of OWNER_LINE_IDS.split(',').map(x => x.trim()).filter(Boolean)) {
    try {
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
      });
      if (!res.ok) console.error('LINE push failed', res.status, await res.text());
    } catch (e) { console.error('LINE push error', e); }
  }
}

// ---- 管理員驗證（POS 與後台）----
function auth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('尚未設定 ADMIN_PASSWORD');
  const h = req.headers.authorization || '';
  const pw = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="muzang"').status(401).send('需要登入');
}

// ---- 頁面 ----
const page = f => (req, res) => res.sendFile(path.join(__dirname, f));
app.get('/', page('index.html'));
app.get('/pos.html', auth, page('pos.html'));
app.get('/admin', auth, page('admin.html'));

// ---- 建立訂位 + LINE Pay 付款 ----
app.post('/api/reserve', async (req, res) => {
  try {
    const b = req.body || {};
    const people = Number(b.c);
    const clean = s => String(s || '').trim().slice(0, 200);
    const r = {
      id: 'MZ' + Date.now() + crypto.randomInt(100, 999),
      name: clean(b.n), phone: clean(b.p), date: clean(b.d), time: clean(b.t),
      people, pkg: clean(b.s), allergy: clean(b.m), purpose: clean(b.o), note: clean(b.x),
      amount: people * DEPOSIT, status: 'pending', token: crypto.randomBytes(8).toString('hex'), created: new Date().toISOString(),
    };
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    if (!r.name || !r.phone || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !/^\d{2}:\d{2}$/.test(r.time))
      return res.status(400).json({ error: '請完整填寫姓名、電話、日期、時間' });
    if (!Number.isInteger(people) || people < 1 || people > 12) return res.status(400).json({ error: '人數需為 1 到 12 位' });
    if (r.date < today) return res.status(400).json({ error: '日期不可早於今天' });
    if (!LINEPAY_CHANNEL_ID || !LINEPAY_CHANNEL_SECRET || !BASE_URL) return res.status(503).json({ error: '付款功能尚未設定完成' });

    const out = await linepay('/v3/payments/request', {
      amount: r.amount, currency: 'TWD', orderId: r.id,
      packages: [{ id: r.id, amount: r.amount, products: [{ name: '沐藏料理所 訂位訂金', quantity: people, price: DEPOSIT }] }],
      redirectUrls: { confirmUrl: BASE_URL + '/linepay/confirm', cancelUrl: BASE_URL + '/linepay/cancel?orderId=' + r.id },
    });
    if (out.returnCode !== '0000') {
      console.error('LINE Pay request failed', out.returnCode, out.returnMessage);
      return res.status(502).json({ error: '建立付款失敗（' + out.returnCode + '），請稍後再試或改用官方 LINE 聯繫' });
    }
    r.transactionId = String(out.info.transactionId);
    const l = load(); l.push(r); save(l);
    notify(summary(r, '🆕 新訂位（待付款）'));
    res.json({ url: out.info.paymentUrl.web });
  } catch (e) { console.error(e); res.status(500).json({ error: '系統忙碌，請稍後再試' }); }
});

// ---- 付款完成回呼：確認扣款 ----
app.get('/linepay/confirm', async (req, res) => {
  const { orderId, transactionId } = req.query;
  const r = load().find(x => x.id === orderId);
  if (!r || String(r.transactionId) !== String(transactionId)) return res.redirect('/result?s=err');
  if (r.status === 'paid') return res.redirect('/result?s=ok&o=' + r.id + '&k=' + r.token);
  try {
    const out = await linepay(`/v3/payments/${transactionId}/confirm`, { amount: r.amount, currency: 'TWD' });
    if (out.returnCode === '0000') {
      update(r.id, x => { x.status = 'paid'; x.paidAt = new Date().toISOString(); });
      notify(summary(r, '✅ 已收訂金，席位保留'));
      return res.redirect('/result?s=ok&o=' + r.id + '&k=' + r.token);
    }
    console.error('LINE Pay confirm failed', out.returnCode, out.returnMessage);
    update(r.id, x => { x.status = 'failed'; });
  } catch (e) { console.error(e); }
  res.redirect('/result?s=err');
});

app.get('/linepay/cancel', (req, res) => {
  update(String(req.query.orderId), x => { if (x.status === 'pending') x.status = 'cancelled'; });
  res.redirect('/result?s=cancel');
});

app.get('/result', (req, res) => {
  const s = req.query.s;
  const r = load().find(x => x.id === req.query.o && x.token === req.query.k);
  const t = { ok: ['訂金已收到', '席位已為您保留，期待與您相聚。訂位編號：' + String(req.query.o || '').replace(/[^\w]/g, '')],
              cancel: ['已取消付款', '訂位尚未成立，如需訂位請重新操作。'],
              err: ['付款未完成', '若已被扣款請聯繫官方 LINE，我們會協助處理。'] }[s] || ['', ''];
  let btn = '';
  if (s === 'ok' && r) {
    const msg = summary(r, '【沐藏料理所 訂位確認】已付訂金');
    btn = `<p><a href="https://line.me/R/oaMessage/${encodeURIComponent(LINE_OA_ID)}/?${encodeURIComponent(msg)}" style="display:inline-block;padding:14px 22px;background:#06a050;color:#fff;border-radius:10px;text-decoration:none">傳送訂位確認給官方 LINE</a></p>`;
  }
  res.send(`<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>沐藏料理所</title>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:12vh auto;padding:20px;text-align:center;line-height:1.7">
<h2>${t[0]}</h2><p>${t[1]}</p>${btn}
<p><a href="https://line.me/R/ti/p/${encodeURIComponent(LINE_OA_ID)}">返回官方 LINE</a></p>
<p style="color:#888">預約專線 0983-629-986</p></body>`);
});

// ---- 查詢官方帳號好友的 User ID（只給管理員，用來設定 OWNER_LINE_IDS）----
app.get('/api/admin/line-followers', auth, async (req, res) => {
  try {
    const token = await lineToken();
    if (!token) return res.status(503).send('LINE 金鑰未設定');
    const r = await fetch('https://api.line.me/v2/bot/followers/ids?limit=300', { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    const out = [];
    for (const id of (j.userIds || []).slice(0, 100)) {
      const p = await (await fetch('https://api.line.me/v2/bot/profile/' + id, { headers: { Authorization: 'Bearer ' + token } })).json();
      out.push({ id, name: p.displayName });
    }
    res.json(out);
  } catch (e) { res.status(500).send(String(e)); }
});

// ---- 後台 API ----
app.get('/api/admin/reservations', auth, (req, res) => res.json(load().reverse()));
app.post('/api/admin/reservations/:id', auth, (req, res) => {
  const st = req.body && req.body.status;
  if (!['paid', 'pending', 'cancelled'].includes(st)) return res.status(400).json({ error: 'bad status' });
  const r = update(req.params.id, x => { x.status = st; });
  res.json(r || {});
});

app.listen(process.env.PORT || 3000, () => console.log('muzang up, LINE Pay env:', LINEPAY_ENV));
