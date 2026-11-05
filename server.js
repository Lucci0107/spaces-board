// Spaces Board MVP. Credentials only from env: X_CLIENT_ID, X_CLIENT_SECRET (optional), BASE_URL, SESSION_SECRET.
const express = require('express'), session = require('express-session'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const PORT = process.env.PORT || 3000, BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const CID = process.env.X_CLIENT_ID, CSEC = process.env.X_CLIENT_SECRET;
const DEMO = !CID;
const SCOPES = 'tweet.read users.read space.read offline.access';
const db = new DatabaseSync(process.env.DB_PATH || 'spaces.db');
db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT, name TEXT);
CREATE TABLE IF NOT EXISTS spaces(id INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT, url TEXT, title TEXT, host TEXT, start_at TEXT, owner_id TEXT, demo INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reminders(user_id TEXT, space_row INTEGER, minutes_before INTEGER DEFAULT 15, sent INTEGER DEFAULT 0, PRIMARY KEY(user_id, space_row));`);
if (DEMO && !db.prepare('SELECT 1 FROM spaces WHERE demo=1').get()) {
  const ins = db.prepare('INSERT INTO spaces(space_id,url,title,host,start_at,owner_id,demo) VALUES(?,?,?,?,?,?,1)');
  [[2,'【サンプル】共創ナビ雑談スペース','NiziUcci'],[26,'【サンプル】X API もくもく会','demo_host'],[50,'【サンプル】週末AIトーク','demo_user']]
    .forEach(([h,t,u],i)=>ins.run('1demo'+i,'https://x.com/i/spaces/1demo'+i,t,u,new Date(Date.now()+h*3600e3).toISOString(),'demo'));
}
const app = express(); app.set('trust proxy', 1);
if (!DEMO) db.exec('DELETE FROM spaces WHERE demo=1');
app.use(express.urlencoded({ extended: false }));
app.use(session({ secret: process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex'), resave: false, saveUninitialized: false }));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fmt = iso => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' (JST)';
const fmtShort = iso => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const rel = iso => { const m = Math.round((new Date(iso) - Date.now()) / 60e3); if (m <= 0 && m > -60) return 'LIVE'; if (m < 60) return `あと${m}分`; if (m < 1440) return `あと${Math.round(m/60)}時間`; return `あと${Math.round(m/1440)}日`; };
const CSS = `:root,[data-theme=dark]{color-scheme:dark;--bg:#07070b;--card:#12121a;--line:#24243a;--tx:#ececf4;--mut:#9a9ab3;--pu:#8b5cf6;--bl:#3b82f6;--pk:#ec4899;--g1:#2a1650;--g2:#0f2a5a;--btn:#1a1a26;--btnh:#211a33;--onbg:#2a1224;--ontx:#fbcfe8;--h1a:#c4b5fd;--h1b:#93c5fd;--ntx:#d4ccf5;--c1:#151520;--c2:#101017;--ch:#3a3360;--sh:var(--sh);--chip:#1c1c2b;--chtx:#c7c7da;--lvbg:#3b0d1d;--lvbd:#be185d;--lvtx:#fda4af;--snbg:#1a1640;--snbd:#5b4bd1;--sntx:#c4b5fd;--sbg:#221b08;--sbd:#5c4a14;--stx:#fcd34d;--time:#a5b4fc;--inp:#0b0b12;--ft:#5c5c75}
[data-theme=light]{color-scheme:light;--bg:#f6f5fb;--card:#ffffff;--line:#e2e0ee;--tx:#1b1a2e;--mut:#5d5b75;--pu:#7c3aed;--bl:#2563eb;--pk:#db2777;--g1:#e9defd;--g2:#dbe8fe;--btn:#ffffff;--btnh:#f3eefe;--onbg:#fde7f3;--ontx:#9d174d;--h1a:#7c3aed;--h1b:#2563eb;--ntx:#4c1d95;--c1:#ffffff;--c2:#fbfaff;--ch:#c4b5fd;--sh:rgba(60,40,120,.08);--chip:#f2f1f8;--chtx:#3f3d56;--lvbg:#ffe4ec;--lvbd:#f9a8c4;--lvtx:#be123c;--snbg:#ede9fe;--snbd:#c4b5fd;--sntx:#5b21b6;--sbg:#fef6dc;--sbd:#f3d77a;--stx:#92600a;--time:#4338ca;--inp:#f9f8fd;--ft:#8a88a3}
.thm{display:inline-flex;border:1px solid var(--line);border-radius:999px;background:var(--btn);padding:3px}.thm button{border:0;background:none;color:var(--mut);font:inherit;font-size:.78rem;padding:5px 10px;border-radius:999px;cursor:pointer;min-height:30px}.thm button[aria-pressed=true]{background:linear-gradient(135deg,var(--pu),var(--bl));color:#fff;font-weight:700}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 10% -10%,var(--g1) 0,transparent 60%),radial-gradient(900px 500px at 110% 0,var(--g2) 0,transparent 55%),var(--bg);color:var(--tx);font-family:"Hiragino Sans","Noto Sans JP","Yu Gothic UI",system-ui,sans-serif;line-height:1.7;min-height:100vh}
a{color:inherit;text-decoration:none}.wrap{max-width:820px;margin:auto;padding:20px 16px 60px}
nav{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}.logo{font-weight:800;font-size:1.1rem;letter-spacing:.02em}.logo span{background:linear-gradient(90deg,var(--pu),var(--bl));-webkit-background-clip:text;color:transparent}
.navr{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:.9rem}.me{color:var(--mut)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;border:1px solid var(--line);background:var(--btn);color:var(--tx);font:inherit;font-size:.85rem;cursor:pointer;transition:.15s}.btn:hover{border-color:var(--pu);background:var(--btnh)}
.btn.pri{background:linear-gradient(135deg,var(--pu),var(--bl));border:0;font-weight:700;color:#fff}.btn.pri:hover{filter:brightness(1.1)}.btn.on{border-color:var(--pk);color:var(--ontx);background:var(--onbg)}
.hero{padding:44px 0 28px}.hero h1{font-size:clamp(1.8rem,6vw,2.8rem);line-height:1.2;margin:0 0 10px;font-weight:800}.hero h1 em{font-style:normal;background:linear-gradient(90deg,var(--h1a),var(--h1b));-webkit-background-clip:text;color:transparent}.hero p{color:var(--mut);margin:0;max-width:34em}
.notice{display:flex;gap:10px;align-items:flex-start;background:rgba(139,92,246,.08);border:1px solid rgba(139,92,246,.3);color:var(--ntx);padding:10px 14px;border-radius:14px;font-size:.85rem;margin-top:18px}
h2{font-size:1rem;color:var(--mut);font-weight:600;margin:26px 0 12px}h2 b{color:var(--tx)}
.card{position:relative;background:linear-gradient(180deg,var(--c1),var(--c2));border:1px solid var(--line);border-radius:20px;padding:18px;margin:12px 0;box-shadow:0 10px 30px var(--sh);transition:.2s}.card:hover{border-color:var(--ch);transform:translateY(-2px)}
.top{display:flex;gap:12px;align-items:center}.av{flex:none;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--pu),var(--pk));box-shadow:0 0 0 3px var(--card),0 0 0 5px rgba(139,92,246,.45)}
.host{font-size:.85rem;color:var(--mut)}.chips{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.chip{font-size:.72rem;padding:3px 10px;border-radius:999px;background:var(--chip);border:1px solid var(--line);color:var(--chtx);white-space:nowrap}.chip.live{background:var(--lvbg);border-color:var(--lvbd);color:var(--lvtx)}.chip.soon{background:var(--snbg);border-color:var(--snbd);color:var(--sntx)}.chip.s{color:var(--stx);border-color:var(--sbd);background:var(--sbg)}
.title{font-size:1.15rem;font-weight:700;margin:14px 0 6px;line-height:1.5}.time{color:var(--time);font-size:.9rem;display:flex;gap:10px;flex-wrap:wrap}.time .rel{color:var(--tx);font-weight:700}
.acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.acts form{margin:0}
.empty{text-align:center;color:var(--mut);padding:40px;border:1px dashed var(--line);border-radius:20px}
.form{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px}.form label{display:block;font-size:.85rem;color:var(--mut);margin:12px 0 6px}.form input{width:100%;padding:11px 14px;border-radius:12px;border:1px solid var(--line);background:var(--inp);color:var(--tx);font:inherit}.form input:focus{outline:none;border-color:var(--pu)}
.msg{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}footer{color:var(--ft);font-size:.75rem;text-align:center;margin-top:40px}
@media(max-width:520px){.chips{margin-left:0;width:100%;justify-content:flex-start}.top{flex-wrap:wrap}.btn{padding:8px 12px}}`;
const page = (req, body, hero = false) => `<!doctype html><html lang="ja" data-theme="dark"><meta charset="utf-8"><script>(function(){var m=localStorage.getItem("theme")||"system",q=matchMedia("(prefers-color-scheme: dark)");function a(){var x=localStorage.getItem("theme")||"system";document.documentElement.dataset.theme=x==="system"?(q.matches?"dark":"light"):x;document.documentElement.dataset.mode=x;document.querySelectorAll(".thm button").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.m===x)})}window.setTheme=function(x){localStorage.setItem("theme",x);a()};q.addEventListener("change",a);a();document.addEventListener("DOMContentLoaded",a)})()</script><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spaces Board</title><style>${CSS}</style><body><div class="wrap">
<nav><a class="logo" href="/">🎙 <span>Spaces Board</span></a><div class="navr"><div class="thm" role="group" aria-label="テーマ"><button type="button" data-m="system" onclick="setTheme('system')">自動</button><button type="button" data-m="light" onclick="setTheme('light')">ライト</button><button type="button" data-m="dark" onclick="setTheme('dark')">ダーク</button></div>${req.session.user ? `<span class="me">@${esc(req.session.user.username)}</span><a class="btn pri" href="/new">＋ スペースを登録</a><a class="btn" href="/logout">ログアウト</a>` : '<a class="btn pri" href="/login">𝕏 でログイン</a>'}</div></nav>
${hero ? `<section class="hero"><h1>スペースの予定を、<br><em>みんなで共有。</em></h1><p>Xスペースの開催予定を登録して一覧で見られる掲示板。気になる回はリマインダーやカレンダーに追加して、聞き逃しを防ごう。</p></section>` : ''}
${DEMO ? '<div class="notice">✨ <div><b>デモモード</b>：Xのキー未設定のため、疑似ユーザーでログインし、サンプルデータを表示しています。</div></div>' : ''}
${body}<footer>Spaces Board · 時刻はすべて日本時間 (JST)</footer></div></body></html>`;
const b64u = b => b.toString('base64url');
const STATE_KEY = process.env.SESSION_SECRET || 'dev-state-key';
app.get('/login', (req, res) => {
  if (DEMO) { req.session.user = { id: 'demo-user', username: 'demo_user', name: 'デモユーザー' }; db.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?)').run('demo-user','demo_user','デモユーザー'); return res.redirect('/'); }
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
  const me = (await (await fetch('https://api.x.com/2/users/me', { headers: { Authorization: 'Bearer ' + tok.access_token } })).json()).data;
  db.prepare('INSERT OR REPLACE INTO users VALUES(?,?,?)').run(me.id, me.username, me.name);
  req.session.user = me; req.session.token = tok.access_token; // token kept in server session only, never in DB/logs
  res.redirect('/');
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
const auth = (req, res, next) => req.session.user ? next() : res.redirect('/login');
app.get('/', (req, res) => {
  const uid = req.session.user?.id;
  const rows = db.prepare(`SELECT s.*, u.username owner, (SELECT 1 FROM reminders r WHERE r.space_row=s.id AND r.user_id=?) rem FROM spaces s LEFT JOIN users u ON u.id=s.owner_id WHERE start_at >= ? ORDER BY start_at`).all(uid ?? '', new Date(Date.now() - 3600e3).toISOString());
  const card = s => { const r = rel(s.start_at), live = r === 'LIVE', soon = !live && (new Date(s.start_at) - Date.now()) < 864e5;
    return `<article class="card"><div class="top"><div class="av">${esc((s.host || '?')[0].toUpperCase())}</div><div><div class="host">@${esc(s.host)}</div></div>
<div class="chips">${s.demo ? '<span class="chip s">サンプル</span>' : ''}<span class="chip ${live ? 'live' : soon ? 'soon' : ''}">${live ? '● LIVE' : soon ? '⏰ まもなく' : '📅 予定'}</span></div></div>
<div class="title">${esc(s.title)}</div><div class="time"><span class="rel">${live ? '配信中' : r}</span><span>${fmtShort(s.start_at)} JST</span></div>
<div class="acts"><a class="btn pri" href="${esc(s.url)}" target="_blank" rel="noopener">▶ 開く</a><a class="btn" href="/spaces/${s.id}.ics">📅 .ics</a>
${uid ? `<form method="post" action="/spaces/${s.id}/remind"><button class="btn ${s.rem ? 'on' : ''}">${s.rem ? '🔔 リマインダー中' : '🔕 リマインダー'}</button></form>` : '<a class="btn" href="/login">🔕 リマインダー</a>'}</div></article>`; };
  res.send(page(req, `<h2>これからのスペース <b>${rows.length}</b> 件</h2>` + (rows.length ? rows.map(card).join('') : '<div class="empty">まだ予定がありません。最初のスペースを登録しよう！</div>'), true));
});
// Extract a Space id from x.com/i/spaces/ID, twitter.com, reminder/share links (?id=, /spaces/ID/peek), or a bare id.
const spaceIdOf = raw => { const t = String(raw || '').trim(); let m = /spaces\/([A-Za-z0-9]{8,20})/i.exec(t) || /[?&](?:space_?id|id)=([A-Za-z0-9]{8,20})/i.exec(t) || /^([A-Za-z0-9]{8,20})$/.exec(t) || /(?:^|[^A-Za-z0-9])(1[A-Za-z0-9]{12})(?![A-Za-z0-9])/.exec(t); return m ? m[1] : null; };
const demoSpace = id => { const h = [...crypto.createHash('sha256').update(id).digest()];
  const topics = ['共創ナビ雑談','X API もくもく会','週末AIトーク','朝活コミュニティ会','クリエイター交流会','新機能おしゃべり'], hosts = ['NiziUcci','demo_host','demo_user','space_fan'];
  const d = new Date(Date.now() + (1 + h[2] % 6) * 864e5); d.setUTCHours(11 + h[3] % 3, 0, 0, 0); // 20:00-22:00 JST
  return { id, title: `【デモ】${topics[h[0] % topics.length]}`, scheduled_start: d.toISOString(), host: hosts[h[1] % hosts.length], state: 'scheduled', demo: true }; };
async function lookupSpace(id, token) {
  const r = await fetch(`https://api.x.com/2/spaces/${encodeURIComponent(id)}?space.fields=title,scheduled_start,started_at,creator_id,state&expansions=creator_id&user.fields=username`, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.data) throw new Error('lookup status ' + r.status);
  let host = j.includes?.users?.find(u => u.id === j.data.creator_id)?.username;
  if (!host && j.data.creator_id) { const u = await (await fetch(`https://api.x.com/2/users/${j.data.creator_id}`, { headers: { Authorization: 'Bearer ' + token } })).json().catch(() => ({})); host = u.data?.username; }
  return { id, title: j.data.title || '', scheduled_start: j.data.scheduled_start || j.data.started_at || null, host: host || '', state: j.data.state };
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
  let { title, host, start } = req.body; let startIso = start ? new Date(start + '+09:00').toISOString() : null;
  if (!title || !startIso) try { const sp = DEMO ? demoSpace(id) : req.session.token ? await lookupSpace(id, req.session.token) : null;
    if (sp) { title = title || sp.title; startIso = startIso || sp.scheduled_start; host = host || sp.host; } } catch (e) { console.warn('space lookup failed'); }
  if (!title || !startIso) return res.status(400).send(page(req, '<div class="msg">タイトルと開始日時を取得できませんでした。「編集」から手入力してください。 <a class="btn" href="/new">戻る</a></div>'));
  db.prepare('INSERT INTO spaces(space_id,url,title,host,start_at,owner_id) VALUES(?,?,?,?,?,?)').run(id, `https://x.com/i/spaces/${id}`, title, host || req.session.user.username, startIso, req.session.user.id);
  res.redirect('/');
});
app.post('/spaces/:id/remind', auth, (req, res) => {
  const u = req.session.user.id, id = +req.params.id;
  if (db.prepare('SELECT 1 FROM reminders WHERE user_id=? AND space_row=?').get(u, id)) db.prepare('DELETE FROM reminders WHERE user_id=? AND space_row=?').run(u, id);
  else db.prepare('INSERT INTO reminders(user_id,space_row) VALUES(?,?)').run(u, id);
  res.redirect('/');
});
app.get('/spaces/:id.ics', (req, res) => {
  const s = db.prepare('SELECT * FROM spaces WHERE id=?').get(+req.params.id); if (!s) return res.sendStatus(404);
  const d = x => new Date(x).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  res.type('text/calendar').attachment(`space-${s.id}.ics`).send(['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SpacesBoard//JA','BEGIN:VEVENT',`UID:space-${s.id}@spaces-board`,`DTSTAMP:${d(Date.now())}`,`DTSTART:${d(s.start_at)}`,`DTEND:${d(new Date(s.start_at).getTime()+3600e3)}`,`SUMMARY:${s.title.replace(/[,;\n]/g,' ')}`,`URL:${s.url}`,`DESCRIPTION:${s.url}`,'BEGIN:VALARM','TRIGGER:-PT15M','ACTION:DISPLAY','DESCRIPTION:スペース開始15分前','END:VALARM','END:VEVENT','END:VCALENDAR'].join('\r\n'));
});
app.get('/healthz', (req, res) => res.json({ ok: true, demo: DEMO }));
// Reminder job stub: every minute, find due reminders. Delivery channel (email / web push / DM via dm.write) TBD.
setInterval(() => {
  const due = db.prepare(`SELECT r.user_id, r.space_row, s.title, s.start_at, u.username FROM reminders r JOIN spaces s ON s.id=r.space_row JOIN users u ON u.id=r.user_id WHERE r.sent=0 AND datetime(s.start_at, '-' || r.minutes_before || ' minutes') <= datetime('now')`).all();
  for (const r of due) { console.log(`[reminder stub] @${r.username}: 「${r.title}」 ${fmt(r.start_at)}`); db.prepare('UPDATE reminders SET sent=1 WHERE user_id=? AND space_row=?').run(r.user_id, r.space_row); }
}, 60e3);
app.listen(PORT, () => console.log(`Spaces Board on ${BASE} (demo=${DEMO})`));
