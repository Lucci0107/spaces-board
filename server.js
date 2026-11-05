// Spaces Board MVP. Credentials only from env: X_CLIENT_ID, X_CLIENT_SECRET (optional), BASE_URL, SESSION_SECRET.
const express = require('express'), session = require('express-session'), crypto = require('crypto');
const { Pool } = require('pg');
const PORT = process.env.PORT || 3000, BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const CID = process.env.X_CLIENT_ID, CSEC = process.env.X_CLIENT_SECRET;
const DEMO = !CID;
const SCOPES = 'tweet.read users.read space.read offline.access';
// Durable storage: Postgres (DATABASE_URL). Render's free disk is wiped on every deploy/restart.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false } });
const pq = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
const db = { prepare: sql => ({ get: async (...p) => (await pool.query(pq(sql), p)).rows[0], all: async (...p) => (await pool.query(pq(sql), p)).rows, run: async (...p) => pool.query(pq(sql), p) }), exec: sql => pool.query(sql) };
const ready = (async () => {
  await db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT, name TEXT, avatar TEXT);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_login TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER DEFAULT 0;
CREATE TABLE IF NOT EXISTS spaces(id SERIAL PRIMARY KEY, space_id TEXT, url TEXT, title TEXT, host TEXT, avatar TEXT, start_at TIMESTAMPTZ, owner_id TEXT, demo INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS reminders(user_id TEXT, space_row INTEGER, minutes_before INTEGER DEFAULT 15, sent INTEGER DEFAULT 0, PRIMARY KEY(user_id, space_row));
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, sess JSONB NOT NULL, expire TIMESTAMPTZ NOT NULL);`);
  if (DEMO && !(await db.prepare('SELECT 1 FROM spaces WHERE demo=1').get())) {
    const ins = db.prepare('INSERT INTO spaces(space_id,url,title,host,start_at,owner_id,demo) VALUES(?,?,?,?,?,?,1)');
    for (const [[h,t,u],i] of [[2,'【サンプル】共創ナビ雑談スペース','NiziUcci'],[26,'【サンプル】X API もくもく会','demo_host'],[50,'【サンプル】週末AIトーク','demo_user']].map((x,i)=>[x,i]))
      await ins.run('1demo'+i,'https://x.com/i/spaces/1demo'+i,t,u,new Date(Date.now()+h*3600e3).toISOString(),'demo');
  }
  if (!DEMO) await db.exec('DELETE FROM spaces WHERE demo=1');
})();
// Sessions in Postgres so logins survive restarts/sleep.
class PgStore extends session.Store {
  get(sid, cb) { pool.query('SELECT sess FROM sessions WHERE sid=$1 AND expire>now()', [sid]).then(r => cb(null, r.rows[0]?.sess || null), cb); }
  set(sid, sess, cb) { const exp = new Date(Date.now() + (sess.cookie?.maxAge || 30 * 864e5)); pool.query('INSERT INTO sessions VALUES($1,$2,$3) ON CONFLICT(sid) DO UPDATE SET sess=$2, expire=$3', [sid, sess, exp]).then(() => cb && cb(), cb); }
  destroy(sid, cb) { pool.query('DELETE FROM sessions WHERE sid=$1', [sid]).then(() => cb && cb(), cb); }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
const app = express(); app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(async (req, res, next) => { try { await ready; next(); } catch (e) { next(e); } });
app.use(session({ store: new PgStore(), cookie: { maxAge: 30 * 864e5, secure: 'auto', sameSite: 'lax' }, secret: process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex'), resave: false, saveUninitialized: false }));
app.use(async (req, res, next) => {
  req.isAdmin = false;
  if (req.session.user && !req.session.csrf) req.session.csrf = crypto.randomBytes(18).toString('base64url');
  const u = req.session.user;
  if (u) { const row = await db.prepare('SELECT role,status,username FROM users WHERE id=?').get(u.id).catch(() => null);
    if (row?.status === 'banned' && !envAdmin(row.username)) { return req.session.destroy(() => res.redirect('/')); }
    req.isAdmin = envAdmin(u.username) || row?.role === 'admin'; }
  next();
});
const csrfOk = req => { const t = String(req.body?._csrf || ''), c = String(req.session.csrf || ''); return t.length === c.length && t.length > 0 && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(c)); };
const csrfIn = req => `<input type="hidden" name="_csrf" value="${req.session.csrf}">`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fmt = iso => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' (JST)';
const fmtShort = iso => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const rel = iso => { const m = Math.round((new Date(iso) - Date.now()) / 60e3); if (m <= 0 && m > -60) return 'LIVE'; if (m < 60) return `あと${m}分`; if (m < 1440) return `あと${Math.round(m/60)}時間`; return `あと${Math.round(m/1440)}日`; };
const CSS = `.av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}:root,[data-theme=dark]{color-scheme:dark;--bg:#0a0a10;--card:#13131c;--line:#262634;--tx:#f1f1f6;--mut:#9b9bb0;--pu:#8b5cf6;--bl:#3b82f6;--pk:#ec4899;--glow:rgba(139,92,246,.16);--btn:#171722;--btnh:#1f1a30;--onbg:#2a1830;--ontx:#f5c2e7;--ntx:#d4ccf5;--sh:rgba(0,0,0,.35);--chbg:rgba(139,92,246,.12);--chbd:#6d4fd8;--chtx:#c4b5fd;--lvbg:#3b0d1d;--lvbd:#be185d;--lvtx:#fda4af;--sbg:#221b08;--sbd:#5c4a14;--stx:#fcd34d;--time:#a9a9be;--inp:#0e0e16;--ft:#5c5c75;--xbg:#ffffff;--xtx:#0a0a10;--seg:#14141d;--segon:#2a2a38;--segtx:#f1f1f6;--logo:#a78bfa}
[data-theme=light]{color-scheme:light;--bg:#f7f7fb;--card:#ffffff;--line:#e6e5ef;--tx:#14132a;--mut:#5f5d78;--pu:#7c3aed;--bl:#3b82f6;--pk:#db2777;--glow:rgba(124,58,237,.07);--btn:#ffffff;--btnh:#f5f1ff;--onbg:#fde7f3;--ontx:#9d174d;--ntx:#4c1d95;--sh:rgba(40,30,90,.07);--chbg:#f1ecff;--chbd:#e2d8fe;--chtx:#6d28d9;--lvbg:#ffe4ec;--lvbd:#f9a8c4;--lvtx:#be123c;--sbg:#fef6dc;--sbd:#f3d77a;--stx:#92600a;--time:#4b4a63;--inp:#f9f8fd;--ft:#8a88a3;--xbg:#0a0a10;--xtx:#ffffff;--seg:#ecebf3;--segon:#ffffff;--segtx:#14132a;--logo:#7c3aed}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 500px at 15% -10%,var(--glow) 0,transparent 60%),var(--bg);color:var(--tx);font-family:Inter,"Hiragino Sans","Noto Sans JP","Yu Gothic UI",system-ui,sans-serif;line-height:1.6;min-height:100vh;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}.wrap{max-width:1080px;margin:auto;padding:22px 20px 60px}
nav{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.15rem}.logo i{font-style:normal;width:40px;height:40px;display:grid;place-items:center;border-radius:12px;background:var(--card);border:1px solid var(--line);box-shadow:0 2px 8px var(--sh);font-size:1.1rem}.logo span b{color:var(--logo)}
.navr{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:.9rem}.me{color:var(--mut)}
.thm{display:inline-flex;border-radius:999px;background:var(--seg);border:1px solid var(--line);padding:4px}.thm button{border:0;background:none;color:var(--mut);font:inherit;font-size:.85rem;padding:6px 16px;border-radius:999px;cursor:pointer;min-height:32px}.thm button[aria-pressed=true]{background:var(--segon);color:var(--segtx);font-weight:700;box-shadow:0 1px 4px var(--sh)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:12px;border:1px solid var(--line);background:var(--btn);color:var(--tx);font:inherit;font-size:.85rem;font-weight:600;cursor:pointer;transition:.15s;white-space:nowrap}.btn:hover{border-color:var(--pu);background:var(--btnh)}
.btn.pri{background:linear-gradient(135deg,var(--pu),#a855f7);border:0;color:#fff}.btn.pri:hover{filter:brightness(1.08)}.btn.x{background:var(--xbg);color:var(--xtx);border:0;border-radius:14px;padding:10px 18px;font-weight:700}.btn.on{border-color:var(--pk);color:var(--ontx);background:var(--onbg)}
.hero{padding:48px 0 30px}.hero h1{font-size:clamp(1.9rem,6vw,3.2rem);line-height:1.2;margin:0 0 14px;font-weight:900;letter-spacing:-.01em}.hero h1 em{font-style:normal;background:linear-gradient(90deg,#a855f7,var(--bl));-webkit-background-clip:text;background-clip:text;color:transparent}.hero p{color:var(--mut);margin:0;max-width:40em}
.notice{display:flex;gap:10px;align-items:flex-start;background:var(--chbg);border:1px solid var(--chbd);color:var(--ntx);padding:10px 14px;border-radius:14px;font-size:.85rem;margin-top:18px}
h2{font-size:1rem;color:var(--mut);font-weight:600;margin:26px 0 14px}h2 b{color:var(--tx)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:18px}
.card{display:grid;grid-template-columns:96px 1fr;gap:6px 18px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 6px 24px var(--sh);transition:.2s}.card:hover{border-color:var(--chbd);transform:translateY(-2px)}
.date{width:96px;height:100px;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;background:linear-gradient(160deg,#a855f7,#6366f1);box-shadow:0 6px 16px rgba(124,58,237,.25);line-height:1.15}.card:nth-child(2n) .date{background:linear-gradient(160deg,#60a5fa,#4f46e5)}.date .d{font-size:1.5rem;font-weight:800}.date .d small{font-size:.9rem;margin-left:2px}.date .h{font-size:1.15rem;font-weight:600;margin-top:6px}
.body{min-width:0}.top{display:flex;gap:10px;align-items:center}.av{position:relative;overflow:hidden;flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--pu),var(--pk));border:2px solid var(--card);box-shadow:0 0 0 1px var(--line)}
.host{font-size:.9rem;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chips{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.chip{font-size:.75rem;padding:3px 12px;border-radius:999px;background:var(--chbg);border:1px solid var(--chbd);color:var(--chtx);white-space:nowrap;font-weight:600}.chip.live{background:var(--lvbg);border-color:var(--lvbd);color:var(--lvtx)}.chip.s{color:var(--stx);border-color:var(--sbd);background:var(--sbg)}
.title{font-size:1.15rem;font-weight:800;margin:10px 0 4px;line-height:1.45;word-break:break-word}.time{color:var(--time);font-size:.88rem;display:flex;gap:10px;flex-wrap:wrap}.time .rel{color:var(--chtx);font-weight:700}
.acts{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.acts form{margin:0}
.empty{text-align:center;color:var(--mut);padding:40px;border:1px dashed var(--line);border-radius:18px}
.form{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px;max-width:720px}.form label{display:block;font-size:.85rem;color:var(--mut);margin:12px 0 6px}.form input{width:100%;padding:11px 14px;border-radius:12px;border:1px solid var(--line);background:var(--inp);color:var(--tx);font:inherit}.form input:focus{outline:none;border-color:var(--pu)}
.msg{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}footer{color:var(--ft);font-size:.75rem;text-align:center;margin-top:40px}
@media(max-width:560px){.wrap{padding:16px 14px 50px}.grid{grid-template-columns:1fr}.card{grid-template-columns:72px 1fr;gap:6px 12px;padding:14px}.date{width:72px;height:80px}.date .d{font-size:1.15rem}.date .h{font-size:.95rem}.thm button{padding:6px 11px}.btn{padding:8px 11px}.hero{padding:30px 0 20px}}`;
const page = (req, body, hero = false) => `<!doctype html><html lang="ja" data-theme="dark"><meta charset="utf-8"><script>(function(){var m=localStorage.getItem("theme")||"system",q=matchMedia("(prefers-color-scheme: dark)");function a(){var x=localStorage.getItem("theme")||"system";document.documentElement.dataset.theme=x==="system"?(q.matches?"dark":"light"):x;document.documentElement.dataset.mode=x;document.querySelectorAll(".thm button").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.m===x)})}window.setTheme=function(x){localStorage.setItem("theme",x);a()};q.addEventListener("change",a);a();document.addEventListener("DOMContentLoaded",a)})()</script><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spaces Board</title><style>${CSS}</style><body><div class="wrap">
<nav><a class="logo" href="/"><i>🎙</i><span>Spaces <b>Board</b></span></a><div class="navr"><div class="thm" role="group" aria-label="テーマ"><button type="button" data-m="system" onclick="setTheme('system')">自動</button><button type="button" data-m="light" onclick="setTheme('light')">ライト</button><button type="button" data-m="dark" onclick="setTheme('dark')">ダーク</button></div>${req.session.user ? `${req.isAdmin ? '<a class="btn" href="/admin">🛡 管理</a>' : ''}<span class="me">@${esc(req.session.user.username)}</span><a class="btn pri" href="/new">＋ スペースを登録</a><a class="btn" href="/logout">ログアウト</a>` : '<a class="btn x" href="/login">𝕏 でログイン</a>'}</div></nav>
${hero ? `<section class="hero"><h1>スペースの予定を、<em>みんなで共有。</em></h1><p>Xスペースの開催予定を登録して一覧で見られる掲示板。気になる回はリマインダーやカレンダーに追加して、聞き逃しを防ごう。</p></section>` : ''}
${DEMO ? '<div class="notice">✨ <div><b>デモモード</b>：Xのキー未設定のため、疑似ユーザーでログインし、サンプルデータを表示しています。</div></div>' : ''}
${body}<footer>Spaces Board · 時刻はすべて日本時間 (JST)</footer></div></body></html>`;
const gcal = s => { const f = t => new Date(t).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,''); return 'https://calendar.google.com/calendar/render?' + new URLSearchParams({ action: 'TEMPLATE', text: s.title, dates: f(s.start_at) + '/' + f(new Date(s.start_at).getTime() + 3600e3), details: s.url, location: s.url }); };
const b64u = b => b.toString('base64url');
const STATE_KEY = process.env.SESSION_SECRET || 'dev-state-key';
const ADMINS = new Set(String(process.env.ADMIN_USERNAMES || '').split(',').map(x => x.trim().replace(/^@/, '').toLowerCase()).filter(Boolean));
const envAdmin = u => ADMINS.has(String(u || '').toLowerCase());
const BANNED_HTML = '<div class="msg">このアカウントは利用停止中です。</div>';
async function recordLogin(me) {
  const ex = await db.prepare('SELECT status FROM users WHERE id=?').get(me.id);
  if (ex?.status === 'banned' && !envAdmin(me.username)) return false;
  await db.prepare(`INSERT INTO users(id,username,name,avatar,first_login,last_login,login_count) VALUES(?,?,?,?,now(),now(),1)
    ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username, name=EXCLUDED.name, avatar=COALESCE(EXCLUDED.avatar, users.avatar), first_login=COALESCE(users.first_login, now()), last_login=now(), login_count=COALESCE(users.login_count,0)+1`).run(me.id, me.username, me.name, me.avatar || null);
  if (envAdmin(me.username)) await db.prepare("UPDATE users SET role='admin', status='active' WHERE id=?").run(me.id);
  return true;
}
app.get('/login', async (req, res) => {
  if (DEMO) { req.session.user = { id: 'demo-user', username: 'demo_user', name: 'デモユーザー' }; const me = { id: 'demo-user', username: 'demo_user', name: 'デモユーザー' }; if (!(await recordLogin(me))) { req.session.user = null; return res.status(403).send(page(req, BANNED_HTML)); } return req.session.save(() => res.redirect('/')); }
  const verifier = b64u(crypto.randomBytes(32)), payload = verifier + '.' + Date.now();
  const state = payload + '.' + b64u(crypto.createHmac('sha256', STATE_KEY).update(payload).digest());
  const q = new URLSearchParams({ response_type: 'code', client_id: CID, redirect_uri: BASE + '/callback', scope: SCOPES, state,
    code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
  res.redirect('https://x.com/i/oauth2/authorize?' + q);
});
app.get('/callback', async (req, res) => {
  const [v, ts, sig] = String(req.query.state || '').split('.');
  const ok = v && ts && sig === b64u(crypto.createHmac('sha256', STATE_KEY).update(v + '.' + ts).digest()) && Date.now() - +ts < 15 * 60 * 1000;
  if (!req.query.code || !ok) { console.error('STATE_ERROR', req.query.error || '', !!req.query.code); return res.status(400).send('ログインをやり直してください（state error）。<a href="/login">もう一度ログイン</a>'); }
  req.session.verifier = v;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (CSEC) headers.Authorization = 'Basic ' + Buffer.from(`${CID}:${CSEC}`).toString('base64');
  const tr = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body: new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: BASE + '/callback', code_verifier: req.session.verifier, client_id: CID }) });
  const tok = await tr.json().catch(()=>({})); if (!tok.access_token) { console.error('TOKEN_ERROR', tr.status, JSON.stringify({error:tok.error,error_description:tok.error_description,title:tok.title,detail:tok.detail}), 'redirect_uri=', BASE + '/callback', 'cid_prefix=', (CID||'').slice(0,6), 'has_secret=', !!CSEC); return res.status(400).send('token error: ' + (tok.error_description || tok.error || tok.detail || tr.status)); }
  const me = (await (await fetch('https://api.x.com/2/users/me?user.fields=profile_image_url', { headers: { Authorization: 'Bearer ' + tok.access_token } })).json()).data;
  if (!(await recordLogin({ ...me, avatar: me.profile_image_url }))) return res.status(403).send(page(req, BANNED_HTML));
  req.session.user = me; req.session.token = tok.access_token; // token kept in server-side session only, never logged
  req.session.save(() => res.redirect('/'));
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
const auth = (req, res, next) => req.session.user ? next() : res.redirect('/login');
app.get('/', async (req, res) => {
  const uid = req.session.user?.id;
  const rows = await db.prepare(`SELECT s.*, u.username owner, (SELECT 1 FROM reminders r WHERE r.space_row=s.id AND r.user_id=?) rem FROM spaces s LEFT JOIN users u ON u.id=s.owner_id WHERE start_at >= ? ORDER BY start_at`).all(uid ?? '', new Date(Date.now() - 3600e3).toISOString());
  rows.forEach(s => s.start_at = new Date(s.start_at).toISOString());
  const card = s => { const r = rel(s.start_at), live = r === 'LIVE', soon = !live && (new Date(s.start_at) - Date.now()) < 864e5;
    const dt = new Date(s.start_at), jp = o => dt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', ...o });
    return `<article class="card"><div class="date"><div class="d">${jp({ month: 'numeric', day: 'numeric' })}<small>${jp({ weekday: 'short' })}</small></div><div class="h">${jp({ hour: '2-digit', minute: '2-digit' })}</div></div><div class="body"><div class="top"><div class="av">${esc((s.host || '?')[0].toUpperCase())}<img src="${esc(s.avatar || 'https://unavatar.io/x/' + encodeURIComponent(s.host || ''))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></div><div class="host">@${esc(s.host)}</div>
<div class="chips">${s.demo ? '<span class="chip s">サンプル</span>' : ''}<span class="chip ${live ? 'live' : soon ? 'soon' : ''}">${live ? '● LIVE' : soon ? '⏰ まもなく' : '📅 予定'}</span></div></div>
<div class="title">${esc(s.title)}</div><div class="time"><span class="rel">${live ? '配信中' : r}</span><span>🕒 ${fmtShort(s.start_at)} JST</span></div></div>
<div class="acts"><a class="btn pri" href="${esc(s.url)}" target="_blank" rel="noopener">▶ 開く</a><a class="btn" href="${gcal(s)}" target="_blank" rel="noopener">📅 Googleカレンダー</a><a class="btn" href="/spaces/${s.id}.ics">.ics</a>
${uid ? `${uid && (s.owner_id === uid || req.isAdmin) ? `<form method="post" action="/spaces/${s.id}/delete" onsubmit="return confirm('このスペースを削除しますか？')">${csrfIn(req)}<button class="btn">🗑 削除</button></form>` : ''}<form method="post" action="/spaces/${s.id}/remind"><button class="btn ${s.rem ? 'on' : ''}">${s.rem ? '🔔 リマインダー中' : '🔕 リマインダー'}</button></form>` : '<a class="btn" href="/login">🔕 リマインダー</a>'}</div></article>`; };
  res.send(page(req, `<h2>これからのスペース <b>${rows.length}</b> 件</h2>` + (rows.length ? '<div class="grid">' + rows.map(card).join('') + '</div>' : '<div class="empty">まだ予定がありません。最初のスペースを登録しよう！</div>'), true));
});
// Extract a Space id from x.com/i/spaces/ID, twitter.com, reminder/share links (?id=, /spaces/ID/peek), or a bare id.
const spaceIdOf = raw => { const t = String(raw || '').trim(); let m = /spaces\/([A-Za-z0-9]{8,20})/i.exec(t) || /[?&](?:space_?id|id)=([A-Za-z0-9]{8,20})/i.exec(t) || /^([A-Za-z0-9]{8,20})$/.exec(t) || /(?:^|[^A-Za-z0-9])(1[A-Za-z0-9]{12})(?![A-Za-z0-9])/.exec(t); return m ? m[1] : null; };
const demoSpace = id => { const h = [...crypto.createHash('sha256').update(id).digest()];
  const topics = ['共創ナビ雑談','X API もくもく会','週末AIトーク','朝活コミュニティ会','クリエイター交流会','新機能おしゃべり'], hosts = ['NiziUcci','demo_host','demo_user','space_fan'];
  const d = new Date(Date.now() + (1 + h[2] % 6) * 864e5); d.setUTCHours(11 + h[3] % 3, 0, 0, 0); // 20:00-22:00 JST
  return { id, title: `【デモ】${topics[h[0] % topics.length]}`, scheduled_start: d.toISOString(), host: hosts[h[1] % hosts.length], state: 'scheduled', demo: true }; };
async function lookupSpace(id, token) {
  const r = await fetch(`https://api.x.com/2/spaces/${encodeURIComponent(id)}?space.fields=title,scheduled_start,started_at,creator_id,state&expansions=creator_id&user.fields=username,profile_image_url`, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.data) throw new Error('lookup status ' + r.status);
  const cu = j.includes?.users?.find(u => u.id === j.data.creator_id); let host = cu?.username, avatar = cu?.profile_image_url;
  if (!host && j.data.creator_id) { const u = await (await fetch(`https://api.x.com/2/users/${j.data.creator_id}`, { headers: { Authorization: 'Bearer ' + token } })).json().catch(() => ({})); host = u.data?.username; }
  if (host && !avatar) try { avatar = (await (await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(host)}?user.fields=profile_image_url`, { headers: { Authorization: 'Bearer ' + token } })).json()).data?.profile_image_url; } catch {}
  return { id, title: j.data.title || '', scheduled_start: j.data.scheduled_start || j.data.started_at || null, host: host || '', avatar: avatar || null, state: j.data.state };
}
app.get('/api/space', auth, async (req, res) => {
  const id = spaceIdOf(req.query.url); if (!id) return res.status(400).json({ error: 'スペースIDが見つかりません。URLを確認してください。' });
  if (DEMO) return res.json(demoSpace(id));
  if (!req.session.token) return res.status(401).json({ id, error: 'ログインし直してください。' });
  try { res.json(await lookupSpace(id, req.session.token)); } catch (e) { console.warn('space lookup failed'); res.status(502).json({ id, error: 'スペース情報を取得できませんでした。手入力してください。' }); }
});
const NEWCSS = `<style>.af{display:none;margin-top:14px;border:1px solid var(--line);border-radius:16px;padding:14px;background:var(--inp)}.af.show{display:block}.af .row{display:flex;justify-content:space-between;align-items:center;gap:8px}.af .st{font-size:.85rem;color:var(--mut)}.form input[readonly]{opacity:.85;border-style:dashed}.hint{font-size:.78rem;color:var(--mut);margin-top:6px}.pv{display:flex;gap:12px;align-items:center;margin-top:10px}.pv .t{font-weight:700}.pv .m{font-size:.85rem;color:var(--time)}</style>`;
app.get('/new', auth, (req, res) => res.send(page(req, `${NEWCSS}<h2><b>スペースを登録</b></h2><form class="form" method="post" action="/new" id="f">
<label for="url">スペースURL（リマインダーのURLでもOK）</label><input id="url" name="url" placeholder="https://x.com/i/spaces/1AbCdEfGhIjKl" required autocomplete="off" inputmode="url">
<div class="hint">URLを貼るだけで、タイトル・開始日時・ホストを自動で入力します。${DEMO ? '<br>※デモモードではIDから仮の値を入れます。本物の情報の取得はXでログインすると動きます。' : ''}</div>
<div class="af" id="af"><div class="row"><span class="st" id="st">読み込み中…</span><button type="button" class="btn" id="ed">✏️ 編集</button></div>
<div class="pv"><div class="av" id="pa">?</div><div><div class="t" id="pt"></div><div class="m" id="pm"></div></div></div>
<div id="fields"><label>タイトル</label><input name="title" id="title" readonly><label>開始日時（JST）</label><input type="datetime-local" name="start" id="start" readonly><label>ホスト（@なし）</label><input name="host" id="host" readonly></div></div>
<div class="acts"><button class="btn pri" id="sb">登録する</button><a class="btn" href="/">キャンセル</a></div></form>
<script>(function(){var f=document.getElementById('f'),u=document.getElementById('url'),af=document.getElementById('af'),st=document.getElementById('st'),T=document.getElementById('title'),S=document.getElementById('start'),H=document.getElementById('host'),last='',ok=false;
function ro(v){[T,S,H].forEach(function(i){i.readOnly=v})}
function jst(iso){var d=new Date(new Date(iso).getTime()+9*36e5);return d.toISOString().slice(0,16)}
function pv(){document.getElementById('pt').textContent=T.value||'（タイトル未入力）';document.getElementById('pm').textContent=(S.value?S.value.replace('T',' ')+' JST':'日時未入力')+(H.value?' ・ @'+H.value:'');document.getElementById('pa').textContent=(H.value||'?')[0].toUpperCase()}
[T,S,H].forEach(function(i){i.addEventListener('input',pv)});
document.getElementById('ed').onclick=function(){ro(false);T.focus()};
function load(){var v=u.value.trim();if(!v||v===last)return Promise.resolve(ok);last=v;af.classList.add('show');st.textContent='⏳ スペース情報を取得中…';
return fetch('/api/space?url='+encodeURIComponent(v)).then(function(r){return r.json().then(function(j){if(!r.ok)throw j;return j})}).then(function(j){T.value=j.title||'';if(j.scheduled_start)S.value=jst(j.scheduled_start);H.value=j.host||'';ro(true);ok=!!(j.title&&j.scheduled_start);
st.textContent=ok?(j.demo?'✨ デモ値を自動入力しました（本物の取得はXログイン後）':'✅ 自動入力しました'):'⚠️ 一部取得できませんでした。編集して補ってください';if(!ok)ro(false);pv();return ok})
.catch(function(e){ok=false;ro(false);st.textContent='⚠️ '+((e&&e.error)||'取得に失敗しました')+' 手入力もできます';pv();return false})}
u.addEventListener('change',load);u.addEventListener('blur',load);u.addEventListener('paste',function(){setTimeout(load,0)});
f.addEventListener('submit',function(e){if(u.value.trim()!==last){e.preventDefault();load().then(function(){f.submit()})}});})()</script>`)));
app.post('/new', auth, async (req, res) => {
  const id = spaceIdOf(req.body.url); if (!id) return res.status(400).send(page(req, '<div class="msg">スペースIDが見つかりませんでした。URLを確認してください。 <a class="btn" href="/new">戻る</a></div>'));
  let { title, host, start } = req.body, avatar = null; let startIso = start ? new Date(start + '+09:00').toISOString() : null;
  if (!title || !startIso) try { const sp = DEMO ? demoSpace(id) : req.session.token ? await lookupSpace(id, req.session.token) : null;
    if (sp) { title = title || sp.title; startIso = startIso || sp.scheduled_start; host = host || sp.host; avatar = sp.avatar || null; } } catch (e) { console.warn('space lookup failed'); }
  if (!avatar && !DEMO && req.session.token && (host || req.session.user.username)) try { const r = await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(host || req.session.user.username)}?user.fields=profile_image_url`, { headers: { Authorization: 'Bearer ' + req.session.token } }); avatar = (await r.json()).data?.profile_image_url || null; } catch {}
  if (!title || !startIso) return res.status(400).send(page(req, '<div class="msg">タイトルと開始日時を取得できませんでした。「編集」から手入力してください。 <a class="btn" href="/new">戻る</a></div>'));
  await db.prepare('INSERT INTO spaces(space_id,url,title,host,avatar,start_at,owner_id) VALUES(?,?,?,?,?,?,?)').run(id, `https://x.com/i/spaces/${id}`, title, (host || req.session.user.username).replace(/^@/, ''), avatar, startIso, req.session.user.id);
  res.redirect('/');
});
app.post('/spaces/:id/remind', auth, async (req, res) => {
  const u = req.session.user.id, id = +req.params.id;
  if (await db.prepare('SELECT 1 FROM reminders WHERE user_id=? AND space_row=?').get(u, id)) await db.prepare('DELETE FROM reminders WHERE user_id=? AND space_row=?').run(u, id);
  else await db.prepare('INSERT INTO reminders(user_id,space_row) VALUES(?,?)').run(u, id);
  res.redirect('/');
});
app.get('/spaces/:id.ics', async (req, res) => {
  const s = await db.prepare('SELECT * FROM spaces WHERE id=?').get(+req.params.id); if (!s) return res.sendStatus(404);
  const d = x => new Date(x).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  res.type('text/calendar').attachment(`space-${s.id}.ics`).send(['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SpacesBoard//JA','BEGIN:VEVENT',`UID:space-${s.id}@spaces-board`,`DTSTAMP:${d(Date.now())}`,`DTSTART:${d(s.start_at)}`,`DTEND:${d(new Date(s.start_at).getTime()+3600e3)}`,`SUMMARY:${s.title.replace(/[,;\n]/g,' ')}`,`URL:${s.url}`,`DESCRIPTION:${s.url}`,'BEGIN:VALARM','TRIGGER:-PT15M','ACTION:DISPLAY','DESCRIPTION:スペース開始15分前','END:VALARM','END:VEVENT','END:VCALENDAR'].join('\r\n'));
});
app.post('/spaces/:id/delete', auth, async (req, res) => {
  if (!csrfOk(req)) return res.status(403).send('CSRF error');
  const s = await db.prepare('SELECT owner_id FROM spaces WHERE id=?').get(+req.params.id); if (!s) return res.redirect('/');
  if (s.owner_id !== req.session.user.id && !req.isAdmin) return res.sendStatus(403);
  await db.prepare('DELETE FROM reminders WHERE space_row=?').run(+req.params.id); await db.prepare('DELETE FROM spaces WHERE id=?').run(+req.params.id);
  res.redirect(req.body.back === 'admin' ? '/admin?tab=spaces' : '/');
});
// ---- Admin ----
const admin = (req, res, next) => !req.session.user ? res.redirect('/login') : req.isAdmin ? next() : res.status(403).send(page(req, '<div class="msg">403 · 管理者のみアクセスできます。</div>'));
const jst = t => t ? new Date(t).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const USERS_SQL = `SELECT u.*, (SELECT count(*)::int FROM spaces s WHERE s.owner_id=u.id AND s.demo=0) spaces FROM users u WHERE (?::text = '' OR u.username ILIKE '%'||?||'%' OR u.name ILIKE '%'||?||'%') ORDER BY u.last_login DESC NULLS LAST`;
const SPACES_SQL = `SELECT s.*, u.username owner FROM spaces s LEFT JOIN users u ON u.id=s.owner_id WHERE (?::text = '' OR s.title ILIKE '%'||?||'%' OR s.host ILIKE '%'||?||'%' OR u.username ILIKE '%'||?||'%') ORDER BY s.start_at DESC`;
const roleOf = u => envAdmin(u.username) || u.role === 'admin' ? 'admin' : 'user';
const ADMCSS = `<style>.wrap{max-width:1320px}.tabs{display:flex;gap:8px;margin:18px 0;flex-wrap:wrap;align-items:center}.tabs .sp{flex:1}.tabs a.on{background:var(--chbg);border-color:var(--chbd);color:var(--chtx)}.srch{display:flex;gap:8px;flex:1;min-width:220px;max-width:420px}.srch input{flex:1;padding:8px 14px;border-radius:12px;border:1px solid var(--line);background:var(--inp);color:var(--tx);font:inherit}
.tbl{background:var(--card);border:1px solid var(--line);border-radius:18px;overflow-x:auto;box-shadow:0 6px 24px var(--sh)}table{width:100%;border-collapse:collapse;font-size:.85rem}th,td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:middle}th{color:var(--mut);font-weight:600;font-size:.78rem;background:var(--inp)}tr:last-child td{border-bottom:0}
.uc{display:flex;gap:10px;align-items:center}.uc .n{font-weight:700}.uc .h{color:var(--mut);font-size:.8rem}.num{font-variant-numeric:tabular-nums;text-align:right}.acts2{display:flex;gap:6px}.acts2 form{margin:0}.acts2 .btn{padding:5px 10px;font-size:.78rem}.btn.dng{color:var(--lvtx);border-color:var(--lvbd)}.chip.ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.4);color:#16a34a}.stat{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:10px}.stat div{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px 16px}.stat b{display:block;font-size:1.5rem}.stat span{color:var(--mut);font-size:.8rem}.tl{max-width:320px;overflow:hidden;text-overflow:ellipsis}</style>`;
const av = (name, url) => `<div class="av">${esc((name || '?')[0].toUpperCase())}${url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</div>`;
app.get('/admin', admin, async (req, res) => {
  const q = String(req.query.q || '').slice(0, 50), tab = req.query.tab === 'spaces' ? 'spaces' : 'users';
  const users = await db.prepare(USERS_SQL).all(q, q, q), allU = await db.prepare(USERS_SQL).all('', '', '');
  const spaces = await db.prepare(SPACES_SQL).all(q, q, q, q);
  const act = (u, a, label, cls = '') => `<form method="post" action="/admin/users/${encodeURIComponent(u.id)}/${a}">${csrfIn(req)}<button class="btn ${cls}">${label}</button></form>`;
  const urow = u => { const r = roleOf(u), fixed = envAdmin(u.username), self = u.id === req.session.user.id;
    return `<tr><td><div class="uc">${av(u.username, u.avatar)}<div><div class="n">${esc(u.name || '')}</div><div class="h">@${esc(u.username)}</div></div></div></td>
<td><span class="chip ${r === 'admin' ? '' : 's'}">${r === 'admin' ? '🛡 管理者' : '👤 ユーザー'}${fixed ? '（固定）' : ''}</span></td>
<td><span class="chip ${u.status === 'banned' ? 'live' : 'ok'}">${u.status === 'banned' ? '⛔ 停止中' : '✓ 有効'}</span></td>
<td>${jst(u.first_login)}</td><td>${jst(u.last_login)}</td><td class="num">${u.login_count || 0}</td><td class="num">${u.spaces}</td>
<td><div class="acts2">${fixed || self ? '<span class="h" style="color:var(--mut);font-size:.78rem">—</span>' : (r === 'admin' ? act(u, 'demote', '👤 ユーザーにする') : act(u, 'promote', '🛡 管理者にする')) + (u.status === 'banned' ? act(u, 'unban', '✓ 停止解除') : act(u, 'ban', '⛔ 停止', 'dng'))}</div></td></tr>`; };
  const srow = s => `<tr><td class="tl"><a href="${esc(s.url)}" target="_blank" rel="noopener"><b>${esc(s.title)}</b></a></td><td>@${esc(s.host)}</td><td>${jst(s.start_at)}</td><td>@${esc(s.owner || '')}</td><td>${jst(s.created_at)}</td>
<td><form method="post" action="/spaces/${s.id}/delete" onsubmit="return confirm('削除しますか？')">${csrfIn(req)}<input type="hidden" name="back" value="admin"><button class="btn dng" style="padding:5px 10px;font-size:.78rem">🗑 削除</button></form></td></tr>`;
  const t = (h, rows) => `<div class="tbl"><table><thead><tr>${h.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${h.length}" style="text-align:center;color:var(--mut)">該当なし</td></tr>`}</tbody></table></div>`;
  res.send(page(req, `${ADMCSS}<h2><b>🛡 管理画面</b> · ログインしたXアカウントとスペースの管理</h2>
<div class="stat"><div><b>${allU.length}</b><span>ユーザー</span></div><div><b>${allU.filter(u => roleOf(u) === 'admin').length}</b><span>管理者</span></div><div><b>${allU.filter(u => u.status === 'banned').length}</b><span>停止中</span></div><div><b>${(await db.prepare('SELECT count(*)::int n FROM spaces WHERE demo=0').get()).n}</b><span>スペース</span></div></div>
<div class="tabs"><a class="btn ${tab === 'users' ? 'on' : ''}" href="/admin?tab=users">👥 ユーザー</a><a class="btn ${tab === 'spaces' ? 'on' : ''}" href="/admin?tab=spaces">🎙 スペース</a>
<form class="srch" method="get" action="/admin"><input type="hidden" name="tab" value="${tab}"><input name="q" value="${esc(q)}" placeholder="🔍 検索（ユーザー名・名前・タイトル）"><button class="btn">検索</button></form><span class="sp"></span>
<a class="btn pri" href="/admin/${tab}.csv">⬇ CSVダウンロード</a></div>
${tab === 'users' ? t(['アカウント', '権限', '状態', '初回ログイン (JST)', '最終ログイン (JST)', 'ログイン回数', '登録数', '操作'], users.map(urow).join('')) : t(['タイトル', 'ホスト', '開始 (JST)', '登録者', '登録日時 (JST)', '操作'], spaces.map(srow).join(''))}`));
});
app.post('/admin/users/:id/:action', admin, async (req, res) => {
  if (!csrfOk(req)) return res.status(403).send('CSRF error');
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!u) return res.redirect('/admin');
  if (envAdmin(u.username) || u.id === req.session.user.id) return res.status(400).send(page(req, '<div class="msg">このアカウントは変更できません。 <a class="btn" href="/admin">戻る</a></div>'));
  const sql = { promote: "UPDATE users SET role='admin' WHERE id=?", demote: "UPDATE users SET role='user' WHERE id=?", ban: "UPDATE users SET status='banned' WHERE id=?", unban: "UPDATE users SET status='active' WHERE id=?" }[req.params.action];
  if (!sql) return res.sendStatus(400);
  await db.prepare(sql).run(u.id);
  if (req.params.action === 'ban') await pool.query(`DELETE FROM sessions WHERE sess->'user'->>'id' = $1`, [u.id]);
  res.redirect('/admin');
});
const csvCell = v => { let x = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; return '"' + x.replace(/"/g, '""') + '"'; };
const sendCsv = (res, name, head, rows) => { res.type('text/csv; charset=utf-8').attachment(name); res.send('\uFEFF' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'); };
app.get('/admin/users.csv', admin, async (req, res) => { const rows = await db.prepare(USERS_SQL).all('', '', '');
  sendCsv(res, 'users.csv', ['X ID', 'ユーザー名', '名前', 'プロフィール画像', '権限', '状態', '初回ログイン(JST)', '最終ログイン(JST)', 'ログイン回数', '登録スペース数'], rows.map(u => [u.id, u.username, u.name, u.avatar, roleOf(u), u.status || 'active', jst(u.first_login), jst(u.last_login), u.login_count || 0, u.spaces])); });
app.get('/admin/spaces.csv', admin, async (req, res) => { const rows = await db.prepare(SPACES_SQL).all('', '', '', '');
  sendCsv(res, 'spaces.csv', ['ID', 'スペースID', 'タイトル', 'ホスト', '開始(JST)', 'URL', '登録者', '登録日時(JST)'], rows.map(s => [s.id, s.space_id, s.title, s.host, jst(s.start_at), s.url, s.owner, jst(s.created_at)])); });
app.get('/healthz', (req, res) => res.json({ ok: true, demo: DEMO }));
// Reminder job stub: every minute, find due reminders. Delivery channel (email / web push / DM via dm.write) TBD.
setInterval(async () => { try {
  const due = await db.prepare(`SELECT r.user_id, r.space_row, s.title, s.start_at, u.username FROM reminders r JOIN spaces s ON s.id=r.space_row JOIN users u ON u.id=r.user_id WHERE r.sent=0 AND s.start_at - make_interval(mins => r.minutes_before) <= now()`).all();
  for (const r of due) { console.log(`[reminder stub] @${r.username}: 「${r.title}」 ${fmt(r.start_at)}`); await db.prepare('UPDATE reminders SET sent=1 WHERE user_id=? AND space_row=?').run(r.user_id, r.space_row); }
  await pool.query('DELETE FROM sessions WHERE expire<now()'); } catch (e) { console.error('reminder job', e.message); }
}, 60e3);
app.listen(PORT, () => console.log(`Spaces Board on ${BASE} (demo=${DEMO})`));
