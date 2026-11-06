// Spaces Board MVP. Credentials only from env: X_CLIENT_ID, X_CLIENT_SECRET (optional), BASE_URL, SESSION_SECRET.
const express = require('express'), session = require('express-session'), crypto = require('crypto');
const { Pool } = require('pg');
const webpush = require('web-push');
const PORT = process.env.PORT || 3000, BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const CID = process.env.X_CLIENT_ID, CSEC = process.env.X_CLIENT_SECRET;
const DEMO = !CID;
const SCOPES = 'tweet.read users.read space.read offline.access';
// Durable storage: Postgres (DATABASE_URL). Render's free disk is wiped on every deploy/restart.
// SSL: none for localhost/Render-internal hosts (no dot); verified TLS for public hosts like Neon.
const pgCfg = raw => { if (!raw) return {}; const u = new URL(raw), h = u.hostname; ['sslmode', 'channel_binding', 'uselibpqcompat'].forEach(k => u.searchParams.delete(k));
  const local = /^(localhost|127\.0\.0\.1)$/.test(h) || !h.includes('.'); return { connectionString: u.toString(), ssl: local ? false : { rejectUnauthorized: !/render\.com$/.test(h) }, max: 5 }; };
const pool = new Pool(pgCfg(process.env.DATABASE_URL));
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
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS has_recording INTEGER DEFAULT 0;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS recording_url TEXT;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS space_state TEXT;
CREATE TABLE IF NOT EXISTS reminders(user_id TEXT, space_row INTEGER, minutes_before INTEGER DEFAULT 15, sent INTEGER DEFAULT 0, PRIMARY KEY(user_id, space_row));
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, sess JSONB NOT NULL, expire TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS push_subs_user_idx ON push_subs(user_id);`);
  // Normalize stored Space URLs so LIVE opens the room, not /peek reminders.
  try { await pool.query(`UPDATE spaces SET url = 'https://x.com/i/spaces/' || space_id WHERE space_id ~ '^[A-Za-z0-9]{8,25}$' AND (url ILIKE '%/peek%' OR url ~ '[?&#]')`); } catch (e) { console.warn('url normalize', e.message); }
  if (DEMO && !(await db.prepare('SELECT 1 FROM spaces WHERE demo=1').get())) {
    const ins = db.prepare('INSERT INTO spaces(space_id,url,title,host,start_at,owner_id,demo,has_recording,recording_url,space_state,ended_at) VALUES(?,?,?,?,?,?,1,?,?,?,?)');
    // First upcoming sample is always "today" in JST (evening if morning, +90m if late); others stay later.
    const todayEve = (() => { const n = new Date(); const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(n).reduce((a,p)=> (a[p.type]=p.value, a), {});
      let h = 20, m = 0; const curH = +parts.hour, curM = +parts.minute; if (curH > 20 || (curH === 20 && curM >= 0)) { h = Math.min(23, curH + 1); m = (curM + 30) % 60; if (curH >= 23) { /* keep +90m from now as fallback */ return new Date(Date.now() + 90*60e3); } }
      return new Date(`${parts.year}-${parts.month}-${parts.day}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+09:00`); })();
    const upcomingDemos = [[todayEve,'【サンプル】本日の共創ナビ雑談','NiziUcci'],[new Date(Date.now()+26*3600e3),'【サンプル】X API もくもく会','demo_host'],[new Date(Date.now()+50*3600e3),'【サンプル】週末AIトーク','demo_user']];
    for (const [[start,t,u],i] of upcomingDemos.map((x,i)=>[x,i]))
      await ins.run('1demo'+i,'https://x.com/i/spaces/1demo'+i,t,u,start.toISOString(),'demo',0,null,'scheduled',null);
    // Past archives with recording (demo)
    const past = [[30,'【サンプル】先週の朝活アーカイブ','NiziUcci'],[80,'【サンプル】クリエイター交流アーカイブ','demo_host'],[200,'【サンプル】AIトーク振り返り','demo_user']];
    for (const [[h,t,u],i] of past.map((x,i)=>[x,i])) {
      const start = new Date(Date.now()-h*3600e3);
      await ins.run('1arch'+i,'https://x.com/i/spaces/1arch'+i,t,u,start.toISOString(),'demo',1,'https://x.com/i/spaces/1arch'+i+'/peek','ended',new Date(start.getTime()+3600e3).toISOString());
    }
  }
  if (!DEMO) await db.exec('DELETE FROM spaces WHERE demo=1');
  // One-time copy from the previous database (MIGRATE_FROM_URL) when this one has no users yet. Sessions are not copied.
  if (process.env.MIGRATE_FROM_URL && !(await db.prepare('SELECT 1 FROM users LIMIT 1').get())) {
    const src = new Pool(pgCfg(process.env.MIGRATE_FROM_URL));
    try { const n = {};
      for (const t of ['users', 'spaces', 'reminders']) { const rows = (await src.query(`SELECT * FROM ${t}`)).rows; n[t] = rows.length;
        for (const r of rows) { const k = Object.keys(r); await pool.query(`INSERT INTO ${t}(${k.join(',')}) VALUES(${k.map((_, i) => '$' + (i + 1)).join(',')}) ON CONFLICT DO NOTHING`, k.map(x => r[x])); } }
      await pool.query("SELECT setval(pg_get_serial_sequence('spaces','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM spaces),1))");
      console.log('MIGRATION_DONE', JSON.stringify(n));
    } catch (e) { console.error('MIGRATION_ERROR', e.message); } finally { await src.end(); }
  }
})();
// Sessions in Postgres so logins survive restarts/sleep.
class PgStore extends session.Store {
  get(sid, cb) { pool.query('SELECT sess FROM sessions WHERE sid=$1 AND expire>now()', [sid]).then(r => cb(null, r.rows[0]?.sess || null), cb); }
  set(sid, sess, cb) { const exp = new Date(Date.now() + (sess.cookie?.maxAge || 30 * 864e5)); pool.query('INSERT INTO sessions VALUES($1,$2,$3) ON CONFLICT(sid) DO UPDATE SET sess=$2, expire=$3', [sid, sess, exp]).then(() => cb && cb(), cb); }
  destroy(sid, cb) { pool.query('DELETE FROM sessions WHERE sid=$1', [sid]).then(() => cb && cb(), cb); }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
const app = express(); app.set('trust proxy', 1);
// Static icons/OG image before DB + session middleware; cached (1 day, 1 week for og/icons is fine to refresh via filename change).
app.use(express.static(require('path').join(__dirname, 'public'), { maxAge: '7d', setHeaders: (res, p) => { if (p.endsWith('.webmanifest')) res.type('application/manifest+json'); } }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '32kb' }));
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
const CSS = `.av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}:root,[data-theme=dark]{color-scheme:dark;--bg:#0a0a10;--card:#13131c;--line:#262634;--tx:#f1f1f6;--mut:#9b9bb0;--pu:#8b5cf6;--bl:#3b82f6;--pk:#ec4899;--glow:rgba(139,92,246,.16);--btn:#171722;--btnh:#1f1a30;--onbg:#2a1830;--ontx:#f5c2e7;--ntx:#d4ccf5;--sh:rgba(0,0,0,.35);--chbg:rgba(139,92,246,.12);--chbd:#6d4fd8;--chtx:#c4b5fd;--lvbg:#3b0d1d;--lvbd:#be185d;--lvtx:#fda4af;--sbg:#221b08;--sbd:#5c4a14;--stx:#fcd34d;--time:#a9a9be;--inp:#0e0e16;--ft:#5c5c75;--xbg:#ffffff;--xtx:#0a0a10;--seg:#14141d;--segon:#2a2a38;--segtx:#f1f1f6;--logo:#a78bfa;--tdbg:rgba(251,146,60,.12);--tdbd:#f59e0b;--tdtx:#fbbf24;--tdcard:#1a140c;--tdglow:rgba(245,158,11,.22)}
[data-theme=light]{color-scheme:light;--bg:#f7f7fb;--card:#ffffff;--line:#e6e5ef;--tx:#14132a;--mut:#5f5d78;--pu:#7c3aed;--bl:#3b82f6;--pk:#db2777;--glow:rgba(124,58,237,.07);--btn:#ffffff;--btnh:#f5f1ff;--onbg:#fde7f3;--ontx:#9d174d;--ntx:#4c1d95;--sh:rgba(40,30,90,.07);--chbg:#f1ecff;--chbd:#e2d8fe;--chtx:#6d28d9;--lvbg:#ffe4ec;--lvbd:#f9a8c4;--lvtx:#be123c;--sbg:#fef6dc;--sbd:#f3d77a;--stx:#92600a;--time:#4b4a63;--inp:#f9f8fd;--ft:#8a88a3;--xbg:#0a0a10;--xtx:#ffffff;--seg:#ecebf3;--segon:#ffffff;--segtx:#14132a;--logo:#7c3aed;--tdbg:#fff7ed;--tdbd:#f59e0b;--tdtx:#b45309;--tdcard:#fffbf5;--tdglow:rgba(245,158,11,.18)}
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
.card{display:grid;grid-template-columns:96px 1fr;gap:6px 18px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 6px 24px var(--sh);transition:.2s}.card:hover{border-color:var(--chbd);transform:translateY(-2px)}.card.today{background:var(--tdcard);border-color:var(--tdbd);box-shadow:0 6px 24px var(--sh),0 0 0 1px var(--tdbd),0 8px 28px var(--tdglow)}.card.today:hover{border-color:var(--tdbd);filter:brightness(1.02)}.card.today .date{background:linear-gradient(160deg,#f59e0b,#ea580c)!important;box-shadow:0 6px 16px rgba(234,88,12,.35)}.chip.today{background:var(--tdbg);border-color:var(--tdbd);color:var(--tdtx)}
.date{width:96px;height:100px;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;background:linear-gradient(160deg,#a855f7,#6366f1);box-shadow:0 6px 16px rgba(124,58,237,.25);line-height:1.15}.card:nth-child(2n) .date{background:linear-gradient(160deg,#60a5fa,#4f46e5)}.date .d{font-size:1.5rem;font-weight:800}.date .d small{font-size:.9rem;margin-left:2px}.date .h{font-size:1.15rem;font-weight:600;margin-top:6px}
.body{min-width:0}.top{display:flex;gap:10px;align-items:center}.av{position:relative;overflow:hidden;flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--pu),var(--pk));border:2px solid var(--card);box-shadow:0 0 0 1px var(--line)}
.host{font-size:.9rem;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hostlink{display:inline-flex;align-items:center;gap:10px;min-width:0;max-width:100%;border:0;background:none;padding:0;margin:0;font:inherit;color:inherit;cursor:pointer;border-radius:999px;text-align:left;text-decoration:none}.hostlink:hover .host,.hostlink:focus-visible .host{color:var(--chtx);text-decoration:underline}.hostlink:focus-visible{outline:2px solid var(--pu);outline-offset:3px}.hostlink .av{pointer-events:none}.hfilter{display:flex;flex-wrap:wrap;gap:10px;align-items:center;background:var(--chbg);border:1px solid var(--chbd);color:var(--ntx);padding:10px 14px;border-radius:14px;font-size:.9rem;margin:0 0 14px}.hfilter b{color:var(--chtx)}.hfilter .sp{flex:1}.chips{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.chip{font-size:.75rem;padding:3px 12px;border-radius:999px;background:var(--chbg);border:1px solid var(--chbd);color:var(--chtx);white-space:nowrap;font-weight:600}.chip.live{background:var(--lvbg);border-color:var(--lvbd);color:var(--lvtx)}.chip.s{color:var(--stx);border-color:var(--sbd);background:var(--sbg)}
.title{font-size:1.15rem;font-weight:800;margin:10px 0 4px;line-height:1.45;word-break:break-word}.time{color:var(--time);font-size:.88rem;display:flex;gap:10px;flex-wrap:wrap}.time .rel{color:var(--chtx);font-weight:700}
.acts{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.acts form{margin:0}
.empty{text-align:center;color:var(--mut);padding:40px;border:1px dashed var(--line);border-radius:18px}
.form{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px;max-width:720px}.form label{display:block;font-size:.85rem;color:var(--mut);margin:12px 0 6px}.form input{width:100%;padding:11px 14px;border-radius:12px;border:1px solid var(--line);background:var(--inp);color:var(--tx);font:inherit}.form input:focus{outline:none;border-color:var(--pu)}
.msg{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}footer{color:var(--ft);font-size:.75rem;text-align:center;margin-top:40px}
.btabs{display:inline-flex;gap:4px;border-radius:999px;background:var(--seg);border:1px solid var(--line);padding:4px;margin:0 0 18px;flex-wrap:wrap}.btabs a{border:0;background:none;color:var(--mut);font:inherit;font-size:.9rem;padding:8px 18px;border-radius:999px;cursor:pointer;min-height:36px;display:inline-flex;align-items:center;gap:6px;font-weight:600}.btabs a[aria-selected=true]{background:var(--segon);color:var(--segtx);font-weight:800;box-shadow:0 1px 4px var(--sh)}.btabs .n{font-size:.75rem;opacity:.75;font-variant-numeric:tabular-nums}.chip.arc{background:var(--chbg);border-color:var(--chbd);color:var(--chtx)}.form .chk{display:flex;align-items:center;gap:10px;margin-top:14px;font-size:.9rem;color:var(--tx)}.form .chk input{width:auto;accent-color:var(--pu)}
@media(max-width:560px){.wrap{padding:16px 14px 50px}.grid{grid-template-columns:1fr}.card{grid-template-columns:72px 1fr;gap:6px 12px;padding:14px}.date{width:72px;height:80px}.date .d{font-size:1.15rem}.date .h{font-size:.95rem}.thm button{padding:6px 11px}.btn{padding:8px 11px}.hero{padding:30px 0 20px}.btabs a{padding:8px 12px;font-size:.82rem}}`;
const OG_T = 'Spaces Board', OG_D = 'これから始まる Xスペースを、みんなで共有。開始時刻・ホスト・リマインダーをひと目で。';
const HEAD = `<meta name="description" content="${OG_D}"><link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><meta name="theme-color" content="#f7f7fb" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0a0a10" media="(prefers-color-scheme: dark)">`
 + `<meta property="og:title" content="${OG_T}"><meta property="og:description" content="${OG_D}"><meta property="og:type" content="website"><meta property="og:url" content="${BASE}/"><meta property="og:image" content="${BASE}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Spaces Board — これから始まる Xスペースを、みんなで共有"><meta property="og:site_name" content="Spaces Board"><meta property="og:locale" content="ja_JP">`
 + `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${OG_T}"><meta name="twitter:description" content="${OG_D}"><meta name="twitter:image" content="${BASE}/og.png">`;
const page = (req, body, hero = false) => `<!doctype html><html lang="ja" data-theme="dark"><meta charset="utf-8"><script>(function(){var m=localStorage.getItem("theme")||"system",q=matchMedia("(prefers-color-scheme: dark)");function a(){var x=localStorage.getItem("theme")||"system";document.documentElement.dataset.theme=x==="system"?(q.matches?"dark":"light"):x;document.documentElement.dataset.mode=x;document.querySelectorAll(".thm button").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.m===x)})}window.setTheme=function(x){localStorage.setItem("theme",x);a()};q.addEventListener("change",a);a();document.addEventListener("DOMContentLoaded",a)})()</script><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spaces Board｜これから始まるXスペースを、みんなで共有</title>${HEAD}<style>${CSS}</style><body><div class="wrap">
<nav><a class="logo" href="/"><img src="/favicon.svg" width="40" height="40" alt="" style="border-radius:12px;box-shadow:0 2px 8px var(--sh)"><span>Spaces <b>Board</b></span></a><div class="navr"><div class="thm" role="group" aria-label="テーマ"><button type="button" data-m="system" onclick="setTheme('system')">自動</button><button type="button" data-m="light" onclick="setTheme('light')">ライト</button><button type="button" data-m="dark" onclick="setTheme('dark')">ダーク</button></div>${req.session.user ? `${req.isAdmin ? '<a class="btn" href="/admin">🛡 管理</a>' : ''}<span class="me">@${esc(req.session.user.username)}</span><a class="btn pri" href="/new">＋ スペースを登録</a><a class="btn" href="/logout">ログアウト</a>` : '<a class="btn x" href="/login">𝕏 でログイン</a>'}</div></nav>
${hero ? `<section class="hero"><h1>スペースの予定を、<em>みんなで共有。</em></h1><p>Xスペースの開催予定を登録して一覧で見られる掲示板。気になる回はリマインダーやカレンダーに追加して、聞き逃しを防ごう。</p></section>` : ''}
${DEMO ? '<div class="notice">✨ <div><b>デモモード</b>：Xのキー未設定のため、疑似ユーザーでログインし、サンプルデータを表示しています。</div></div>' : ''}
${body}<footer>Spaces Board · 時刻はすべて日本時間 (JST)</footer></div></body></html>`;
const spaceIdFromStored = s => {
  const sid = String(s?.space_id || '').trim();
  if (/^[A-Za-z0-9]{8,25}$/.test(sid)) return sid;
  const u = String(s?.url || '');
  const m = /(?:^|\/)(?:i\/)?spaces\/([A-Za-z0-9]{8,25})(?:\/|\?|#|$)/i.exec(u) || /[?&](?:space_?id|id)=([A-Za-z0-9]{8,25})/i.exec(u);
  return m ? m[1] : null;
};
// LIVE room URL — never /peek or share query params (those stay on the reminder page).
const spaceOpenUrl = s => {
  const id = spaceIdFromStored(s);
  if (id) return `https://x.com/i/spaces/${id}`;
  return String(s?.url || '').replace(/\/peek(?=\?|$)/i, '').replace(/\?.*$/, '') || 'https://x.com/i/spaces';
};
const gcal = s => { const link = spaceOpenUrl(s); const f = t => new Date(t).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,''); return 'https://calendar.google.com/calendar/render?' + new URLSearchParams({ action: 'TEMPLATE', text: s.title, dates: f(s.start_at) + '/' + f(new Date(s.start_at).getTime() + 3600e3), details: link, location: link }); };
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@spaces-board.onrender.com';
const CRON_SECRET = process.env.CRON_SECRET || '';
const PUSH_READY = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (PUSH_READY) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

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
  req.session.user = me;
  // Access tokens expire ~2h; keep refresh_token (offline.access) so Spaces lookup keeps working.
  req.session.token = tok.access_token;
  if (tok.refresh_token) req.session.refresh_token = tok.refresh_token;
  req.session.token_expires_at = Date.now() + Math.max(60, Number(tok.expires_in) || 7200) * 1000;
  req.session.save(() => res.redirect('/'));
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
const auth = (req, res, next) => req.session.user ? next() : res.redirect('/login');
const CUTOFF_MS = 3600e3; // keep "live" for 1h after start in upcoming
const isPast = s => {
  if (s.space_state === 'ended' || s.ended_at) return true;
  if (s.space_state === 'live' || s.space_state === 'scheduled') return false;
  return new Date(s.start_at).getTime() < Date.now() - CUTOFF_MS;
};
// Calendar date in Asia/Tokyo (YYYY-MM-DD), independent of server/browser local TZ.
const jstYmd = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
const isTodayJst = iso => jstYmd(iso) === jstYmd(Date.now());
const normHost = raw => {
  const t = String(raw || '').trim().replace(/^@+/, '');
  return /^[A-Za-z0-9_]{1,40}$/.test(t) ? t : '';
};
const boardHref = (tab, host) => {
  const q = new URLSearchParams();
  if (tab && tab !== 'upcoming') q.set('tab', tab);
  if (host) q.set('host', host);
  const qs = q.toString();
  return qs ? '/?' + qs : '/';
};
// back field: 'upcoming' | 'archive' | 'upcoming|Host' | 'archive|Host' | 'admin'
const boardBack = raw => {
  const t = String(raw || '');
  if (t === 'admin') return '/admin?tab=spaces';
  const [tabPart, hostPart] = t.split('|');
  const tab = tabPart === 'archive' ? 'archive' : 'upcoming';
  return boardHref(tab, normHost(hostPart || ''));
};
app.get('/', async (req, res) => {
  const uid = req.session.user?.id;
  const tab = req.query.tab === 'archive' ? 'archive' : 'upcoming';
  const hostFilter = normHost(req.query.host);
  const cutoff = new Date(Date.now() - CUTOFF_MS).toISOString();
  const base = `SELECT s.*, u.username owner, (SELECT 1 FROM reminders r WHERE r.space_row=s.id AND r.user_id=?) rem FROM spaces s LEFT JOIN users u ON u.id=s.owner_id`;
  // Filter by spaces.host (X Space host username), not listing registrant (owner_id).
  const hostSql = hostFilter ? ' AND LOWER(s.host)=LOWER(?)' : '';
  const upArgs = hostFilter ? [uid ?? '', cutoff, hostFilter] : [uid ?? '', cutoff];
  const arArgs = hostFilter ? [uid ?? '', cutoff, hostFilter] : [uid ?? '', cutoff];
  const upcoming = await db.prepare(`${base} WHERE start_at >= ? AND COALESCE(space_state,'') <> 'ended'${hostSql} ORDER BY start_at`).all(...upArgs);
  const archive = await db.prepare(`${base} WHERE has_recording=1 AND (ended_at IS NOT NULL OR space_state='ended' OR start_at < ?)${hostSql} ORDER BY COALESCE(ended_at, start_at) DESC`).all(...arArgs);
  const rows = tab === 'archive' ? archive : upcoming;
  rows.forEach(s => { s.start_at = new Date(s.start_at).toISOString(); if (s.ended_at) s.ended_at = new Date(s.ended_at).toISOString(); });
  const card = s => { const past = tab === 'archive' || isPast(s); const r = rel(s.start_at), live = !past && r === 'LIVE', soon = !past && !live && (new Date(s.start_at) - Date.now()) < 864e5;
    const today = !past && isTodayJst(s.start_at);
    const dt = new Date(s.start_at), jp = o => dt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', ...o });
    const openUrl = (past && s.recording_url) ? s.recording_url : spaceOpenUrl(s);
    // LIVE chip stays for live spaces; 「本日」 is an extra badge for JST calendar-today.
    const statusChip = past ? `<span class="chip arc">🎙 アーカイブ</span>` : `<span class="chip ${live ? 'live' : soon ? 'soon' : ''}">${live ? '● LIVE' : soon ? '⏰ まもなく' : '📅 予定'}</span>`;
    const todayChip = today ? '<span class="chip today">🔥 本日</span>' : '';
    const own = uid && (s.owner_id === uid || req.isAdmin);
    const hName = String(s.host || '').replace(/^@/, '');
    const hostBtn = hName
      ? `<a class="hostlink" href="${esc(boardHref(tab, hName))}" title="@${esc(hName)} のスペースを表示" aria-label="ホスト @${esc(hName)} のスペースを表示"><span class="av" aria-hidden="true">${esc((hName || '?')[0].toUpperCase())}<img src="${esc(s.avatar || 'https://unavatar.io/x/' + encodeURIComponent(hName))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></span><span class="host">@${esc(hName)}</span></a>`
      : `<div class="av">?</div><div class="host">（ホスト不明）</div>`;
    const backVal = hostFilter ? `${tab}|${hostFilter}` : tab;
    return `<article class="card${today ? ' today' : ''}"${today ? ' data-today="1"' : ''}><div class="date"><div class="d">${jp({ month: 'numeric', day: 'numeric' })}<small>${jp({ weekday: 'short' })}</small></div><div class="h">${jp({ hour: '2-digit', minute: '2-digit' })}</div></div><div class="body"><div class="top">${hostBtn}
<div class="chips">${s.demo ? '<span class="chip s">サンプル</span>' : ''}${todayChip}${+s.has_recording && !past ? '<span class="chip arc">🎙 録音予定</span>' : ''}${statusChip}</div></div>
<div class="title">${esc(s.title)}</div><div class="time"><span class="rel">${past ? '終了' : live ? '配信中' : r}</span><span>🕒 ${fmtShort(s.start_at)} JST</span></div></div>
<div class="acts"><a class="btn pri" href="${esc(openUrl)}" target="_blank" rel="noopener">${past ? '▶ 録音を聴く' : '▶ 開く'}</a>${past ? '' : `<a class="btn" href="${gcal(s)}" target="_blank" rel="noopener">📅 Googleカレンダー</a><a class="btn" href="/spaces/${s.id}.ics">.ics</a>`}
${uid ? `${own ? `<a class="btn" href="/spaces/${s.id}/edit">✏️ 編集</a><form method="post" action="/spaces/${s.id}/delete" onsubmit="return confirm('このスペースを削除しますか？')">${csrfIn(req)}<input type="hidden" name="back" value="${esc(backVal)}"><button class="btn">🗑 削除</button></form>` : ''}${past ? '' : `<form class="rem-form" method="post" action="/spaces/${s.id}/remind" data-rem-on="${s.rem ? '0' : '1'}"><input type="hidden" name="back" value="${esc(backVal)}"><button type="submit" class="btn ${s.rem ? 'on' : ''}" title="開始15分前にブラウザに通知します">${s.rem ? '🔔 リマインダー中' : '🔕 リマインダー'}</button></form>`}` : (past ? '' : '<a class="btn" href="/login" title="開始15分前にブラウザに通知します">🔕 リマインダー</a>')}</div></article>`; };
  const tabs = `<div class="btabs" role="tablist" aria-label="表示切替"><a role="tab" href="${esc(boardHref('upcoming', hostFilter))}" aria-selected="${tab==='upcoming'}" id="tab-upcoming">これからの予定 <span class="n">${upcoming.length}</span></a><a role="tab" href="${esc(boardHref('archive', hostFilter))}" aria-selected="${tab==='archive'}" id="tab-archive">過去のアーカイブ <span class="n">${archive.length}</span></a></div>
<script>(function(){var q=new URLSearchParams(location.search),h=location.hash.replace(/^#/,''),tab=q.get('tab')||'upcoming',host=q.get('host')||'';
function go(t,ho){var p=new URLSearchParams();if(t&&t!=='upcoming')p.set('tab',t);if(ho)p.set('host',String(ho).replace(/^@/,''));var s=p.toString(),path=s?'/?'+s:'/';if(location.pathname+location.search!==path)location.replace(path)}
if(/^host=/i.test(h)){var m=h.match(/^host=@?([A-Za-z0-9_]{1,40})$/i);if(m)go(tab,m[1]);}
else if(h==='archive'||h==='upcoming'){if(q.get('tab')!==h)go(h,host);}})()</script>`;
  const filterBar = hostFilter
    ? `<div class="hfilter" role="status" data-host-filter="${esc(hostFilter)}"><span>🎙 ホスト <b>@${esc(hostFilter)}</b> のスペース</span><span class="sp"></span><a class="btn" href="${esc(boardHref(tab, ''))}" aria-label="ホスト絞り込みを解除してすべて表示">✕ すべて表示</a></div>`
    : '';
  const empty = tab === 'archive'
    ? (hostFilter
      ? `<div class="empty">このホストの録音アーカイブはありません。</div>`
      : '<div class="empty">録音ありのアーカイブはまだありません。<br>終了後、登録者が「録音あり」にするとここに表示されます。</div>')
    : (hostFilter
      ? `<div class="empty">このホストのこれから予定はありません。</div>`
      : '<div class="empty">まだ予定がありません。最初のスペースを登録しよう！</div>');
  const heading = tab === 'archive' ? `過去のアーカイブ（録音あり） <b>${rows.length}</b> 件` : `これからのスペース <b>${rows.length}</b> 件`;
  const needPush = !!(uid && (upcoming.some(x => x.rem) || archive.some(x => x.rem)));
  const pushBoot = (uid && PUSH_READY) ? `<div id="push-msg" class="notice" style="display:none;margin:0 0 14px"></div>
<script>
window.__SB_PUSH__={vapid:${JSON.stringify(VAPID_PUBLIC)},need:${needPush ? 'true' : 'false'}};
(function(){
  if(!window.__SB_PUSH__.vapid||!('serviceWorker' in navigator)||!('PushManager' in window)) return;
  function b64(s){var p='='.repeat((4-s.length%4)%4),r=(s+p).replace(/-/g,'+').replace(/_/g,'/');var raw=atob(r),o=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)o[i]=raw.charCodeAt(i);return o}
  function showPushMsg(t){var el=document.getElementById('push-msg'); if(!el) return; el.style.display='flex'; el.innerHTML='🔔 <div>'+t+'</div>'}
  async function ensurePush(){
    try{
      var reg=await navigator.serviceWorker.register('/sw.js',{scope:'/'});
      await navigator.serviceWorker.ready;
      var perm=Notification.permission;
      if(perm==='denied'){showPushMsg('ブラウザ通知がブロックされています。設定から許可してください（iOSはホーム画面追加が必要な場合があります）。');return false}
      if(perm!=='granted'){perm=await Notification.requestPermission(); if(perm!=='granted'){showPushMsg('通知が許可されませんでした。リマインダーはブラウザ通知で届きます。');return false}}
      var sub=await reg.pushManager.getSubscription();
      if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(window.__SB_PUSH__.vapid)});
      await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(sub)});
      return true;
    }catch(e){console.warn('push subscribe',e);showPushMsg('通知の登録に失敗しました。HTTPSと通知許可を確認してください。');return false}
  }
  document.querySelectorAll('form.rem-form').forEach(function(f){
    f.addEventListener('submit',function(ev){
      if(f.getAttribute('data-rem-on')!=='1') return;
      ev.preventDefault();
      ensurePush().finally(function(){ HTMLFormElement.prototype.submit.call(f); });
    });
  });
  if(window.__SB_PUSH__.need) ensurePush();
})();
</script>` : '';
  res.send(page(req, filterBar + tabs + pushBoot + `<h2>${heading}</h2>` + (rows.length ? '<div class="grid">' + rows.map(card).join('') + '</div>' : empty), true));
});
// Extract a Space id from x.com/i/spaces/ID, twitter.com, reminder/share links (?id=, /spaces/ID/peek), or a bare id.
const spaceIdOf = raw => {
  const t = String(raw || '').trim();
  let m = /(?:^|\/)(?:i\/)?spaces\/([A-Za-z0-9]{8,25})(?:\/|\?|#|$)/i.exec(t)
    || /[?&](?:space_?id|id)=([A-Za-z0-9]{8,25})/i.exec(t)
    || /^([A-Za-z0-9]{8,25})$/.exec(t)
    || /(?:^|[^A-Za-z0-9])(1[A-Za-z0-9]{11,24})(?![A-Za-z0-9])/.exec(t);
  return m ? m[1] : null;
};
// Follow one hop for t.co / x.com short links only (SSRF-safe allowlist).
async function resolveSpaceId(raw) {
  let id = spaceIdOf(raw); if (id) return id;
  const t = String(raw || '').trim();
  let u; try { u = new URL(t); } catch { return null; }
  if (!/^(t\.co|x\.co)$/i.test(u.hostname)) return null;
  try {
    const r = await fetch(u.toString(), { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SpacesBoard/1.0' } });
    const loc = r.headers.get('location');
    if (loc) return spaceIdOf(loc);
  } catch {}
  return null;
}
async function refreshUserToken(req) {
  const rt = req.session.refresh_token;
  if (!rt || !CID) return null;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (CSEC) headers.Authorization = 'Basic ' + Buffer.from(`${CID}:${CSEC}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: CID });
  const r = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.access_token) {
    console.warn('TOKEN_REFRESH_FAIL', r.status, tok.error || tok.error_description || tok.detail || '');
    // Spent/invalid refresh: force re-login for API calls.
    delete req.session.token; delete req.session.refresh_token; delete req.session.token_expires_at;
    return null;
  }
  req.session.token = tok.access_token;
  if (tok.refresh_token) req.session.refresh_token = tok.refresh_token; // rotation
  req.session.token_expires_at = Date.now() + Math.max(60, Number(tok.expires_in) || 7200) * 1000;
  await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
  return tok.access_token;
}
async function ensureAccessToken(req) {
  if (!req.session.token && !req.session.refresh_token) return null;
  const exp = Number(req.session.token_expires_at) || 0;
  // Refresh 2 minutes early; also when expires_at unknown but refresh exists and token is old session.
  if (req.session.token && exp && exp > Date.now() + 120e3) return req.session.token;
  if (req.session.refresh_token) {
    const t = await refreshUserToken(req);
    if (t) return t;
  }
  return req.session.token || null;
}
const demoSpace = id => { const h = [...crypto.createHash('sha256').update(id).digest()];
  const topics = ['共創ナビ雑談','X API もくもく会','週末AIトーク','朝活コミュニティ会','クリエイター交流会','新機能おしゃべり'], hosts = ['NiziUcci','demo_host','demo_user','space_fan'];
  const d = new Date(Date.now() + (1 + h[2] % 6) * 864e5); d.setUTCHours(11 + h[3] % 3, 0, 0, 0); // 20:00-22:00 JST
  return { id, title: `【デモ】${topics[h[0] % topics.length]}`, scheduled_start: d.toISOString(), host: hosts[h[1] % hosts.length], state: 'scheduled', demo: true }; };
async function lookupSpace(id, token) {
  // Official space.fields only. API id pattern is ^[a-zA-Z0-9]{1,13}$ — 14+ char ids return 400.
  const fields = 'title,scheduled_start,started_at,ended_at,creator_id,state,is_ticketed';
  const r = await fetch(`https://api.x.com/2/spaces/${encodeURIComponent(id)}?space.fields=${fields}&expansions=creator_id&user.fields=username,profile_image_url`, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.data) {
    const detail = j.title || j.detail || j.errors?.[0]?.message || j.error || '';
    const err = new Error('lookup status ' + r.status + (detail ? ': ' + detail : ''));
    err.status = r.status; err.detail = detail;
    err.invalidId = r.status === 400 && /does not match|Invalid Request|id query parameter/i.test(String(detail) + ' ' + JSON.stringify(j.errors || []));
    throw err;
  }
  const cu = j.includes?.users?.find(u => u.id === j.data.creator_id); let host = cu?.username, avatar = cu?.profile_image_url;
  if (!host && j.data.creator_id) { const u = await (await fetch(`https://api.x.com/2/users/${j.data.creator_id}`, { headers: { Authorization: 'Bearer ' + token } })).json().catch(() => ({})); host = u.data?.username; }
  if (host && !avatar) try { avatar = (await (await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(host)}?user.fields=profile_image_url`, { headers: { Authorization: 'Bearer ' + token } })).json()).data?.profile_image_url; } catch {}
  const d = j.data;
  return { id, title: d.title || '', scheduled_start: d.scheduled_start || d.started_at || null, ended_at: d.ended_at || null, host: host || '', avatar: avatar || null, state: d.state, source: 'api' };
}
// SSRF-safe: only build URL from already-parsed alphanumeric id; allowlist x.com/twitter.com; follow same-host /i/spaces redirects.
async function fetchSpacePublicHtml(id) {
  if (!/^[A-Za-z0-9]{8,25}$/.test(id)) { const e = new Error('bad id'); e.status = 400; throw e; }
  const allow = /^(www\.)?(x\.com|twitter\.com)$/i;
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; SpacesBoard/1.0)', 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' };
  let url = `https://x.com/i/spaces/${id}`;
  for (let hop = 0; hop < 3; hop++) {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', headers });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location'); if (!loc) break;
      let next; try { next = new URL(loc, url); } catch { break; }
      if (!allow.test(next.hostname) || !/^\/i\/spaces\/[A-Za-z0-9]{8,25}(\/|$)/i.test(next.pathname)) break;
      url = next.toString(); continue;
    }
    const html = await r.text();
    return { status: r.status, html, url };
  }
  const r = await fetch(url, { method: 'GET', redirect: 'follow', headers });
  return { status: r.status, html: await r.text(), url: r.url };
}
function parseSpacePublicHtml(id, html) {
  const og = (html.match(/property=["']og:title["']\s+content=["']([^"']*)["']/i) || html.match(/content=["']([^"']*)["']\s+property=["']og:title["']/i) || [])[1] || '';
  if (/Audio Space Not Found/i.test(html) || /Audio Space Not Found/i.test(og) || /404 Error/i.test(og)) {
    const e = new Error('space not found on public page'); e.status = 404; throw e;
  }
  let title = '';
  if (og && !/Audio Space Not Found/i.test(og)) {
    // EN + JA og prefixes used by x.com depending on Accept-Language
    title = og.replace(/^(Scheduled|LIVE|Live|Ended|スケジュール済み|ライブ|配信中|終了):\s*/i, '').replace(/\s*\/\s*X\s*$/i, '').trim();
  }
  if (!title) {
    // Embedded JSON often uses \"title\":\"...\"
    const tm = html.match(/\\?"title\\?":\\?"((?:\\.|[^"\\])*)\\?"/);
    if (tm) try { title = JSON.parse('"' + tm[1].replace(/\\"/g, '"') + '"'); } catch { title = tm[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); }
  }
  // SSR HTML embeds GraphQL JSON inside a JS string, so quotes are often backslash-escaped.
  const msM = html.match(/\\?"scheduled_start\\?"\s*:\s*(\d{11,16})/);
  const scheduled_start = msM ? new Date(+msM[1]).toISOString() : null;
  let host = '';
  const creator = (html.match(/name=["']twitter:creator["']\s+content=["']@?([^"']+)["']/i) || [])[1];
  if (creator) host = creator.replace(/^@/, '');
  if (!host) {
    const sm = html.match(/\\?"screen_name\\?"\s*:\s*\\?"([A-Za-z0-9_]{1,40})\\?"/);
    if (sm) host = sm[1];
  }
  let avatar = null;
  const av = html.match(/https:\\\/\\\/pbs\.twimg\.com\\\/profile_images\\\/[0-9]+\\\/[A-Za-z0-9_-]+(?:_normal)?\.(?:jpg|jpeg|png|webp)/)
    || html.match(/https:\/\/pbs\.twimg\.com\/profile_images\/[0-9]+\/[A-Za-z0-9_-]+(?:_normal)?\.(?:jpg|jpeg|png|webp)/);
  if (av) avatar = av[0].replace(/\\\//g, '/');
  const stRaw = (html.match(/\\?"state\\?"\s*:\s*\\?"(NotStarted|Running|Ended|Canceled|Live)\\?"/i) || [])[1] || '';
  const stateMap = { NotStarted: 'scheduled', Running: 'live', Live: 'live', Ended: 'ended', Canceled: 'canceled' };
  const state = stateMap[stRaw] || (stRaw ? stRaw.toLowerCase() : null);
  if (!title && !scheduled_start && !host) { const e = new Error('public page parse empty'); e.status = 502; throw e; }
  return { id, title: title || '', scheduled_start, ended_at: null, host: host || '', avatar, state, source: 'public_html' };
}
async function lookupSpaceFromPublicPage(id) {
  const { status, html } = await fetchSpacePublicHtml(id);
  if (status === 404) { const e = new Error('public page 404'); e.status = 404; throw e; }
  return parseSpacePublicHtml(id, html);
}
async function lookupSpaceForReq(req, id) {
  // Official API rejects ids longer than 13 chars (400 Invalid Request). Use public HTML fallback.
  const useApi = String(id).length <= 13;
  if (useApi) {
    let token = await ensureAccessToken(req);
    if (!token) { const e = new Error('no access token'); e.status = 401; throw e; }
    try { return await lookupSpace(id, token); }
    catch (e) {
      if ((e.status === 401 || e.status === 403) && req.session.refresh_token) {
        token = await refreshUserToken(req);
        if (token) {
          try { return await lookupSpace(id, token); }
          catch (e2) { e = e2; }
        } else { e.status = 401; }
      }
      // Fallback for invalid-id-pattern (400) or missing space (404).
      if (e.status === 400 || e.status === 404 || e.invalidId) {
        try { return await lookupSpaceFromPublicPage(id); }
        catch (e3) {
          if (e.status === 401 || e.status === 403) throw e;
          throw e3.status ? e3 : e;
        }
      }
      throw e;
    }
  }
  return await lookupSpaceFromPublicPage(id);
}
app.get('/api/space', auth, async (req, res) => {
  const id = await resolveSpaceId(req.query.url); if (!id) return res.status(400).json({ error: 'スペースIDが見つかりません。URLを確認してください。' });
  if (DEMO) return res.json(demoSpace(id));
  try {
    const sp = await lookupSpaceForReq(req, id);
    res.json(sp);
  } catch (e) {
    const st = e.status || 502;
    console.warn('space lookup failed', st, (e.message || '').slice(0, 160));
    if (st === 401 || st === 403) return res.status(401).json({ id, error: 'ログインの有効期限が切れました。もう一度ログインしてください。', reauth: true });
    // Only real not-found (after public-page fallback) uses the ended/private copy — not raw API 400 id-pattern errors.
    if (st === 404) return res.status(404).json({ id, error: 'このスペースは取得できませんでした（終了・削除・非公開の可能性があります）。手入力もできます。' });
    if (st === 429) return res.status(429).json({ id, error: 'X APIの利用上限に達しました。しばらくしてから再試行してください。' });
    res.status(502).json({ id, error: 'スペース情報を取得できませんでした。手入力してください。' });
  }
});
const NEWCSS = `<style>.af{display:none;margin-top:14px;border:1px solid var(--line);border-radius:16px;padding:14px;background:var(--inp)}.af.show{display:block}.af .row{display:flex;justify-content:space-between;align-items:center;gap:8px}.af .st{font-size:.85rem;color:var(--mut)}.form input[readonly]{opacity:.85;border-style:dashed}.hint{font-size:.78rem;color:var(--mut);margin-top:6px}.pv{display:flex;gap:12px;align-items:center;margin-top:10px}.pv .t{font-weight:700}.pv .m{font-size:.85rem;color:var(--time)}</style>`;
app.get('/new', auth, (req, res) => res.send(page(req, `${NEWCSS}<h2><b>スペースを登録</b></h2><form class="form" method="post" action="/new" id="f">
<label for="url">スペースURL（リマインダーのURLでもOK）</label><input id="url" name="url" placeholder="https://x.com/i/spaces/1AbCdEfGhIjKl" required autocomplete="off" inputmode="url">
<div class="hint">URLを貼るだけで、タイトル・開始日時・ホストを自動で入力します。${DEMO ? '<br>※デモモードではIDから仮の値を入れます。本物の情報の取得はXでログインすると動きます。' : ''}</div>
<div class="af" id="af"><div class="row"><span class="st" id="st">読み込み中…</span><button type="button" class="btn" id="ed">✏️ 編集</button></div>
<div class="pv"><div class="av" id="pa">?</div><div><div class="t" id="pt"></div><div class="m" id="pm"></div></div></div>
<div id="fields"><label>タイトル</label><input name="title" id="title" readonly><label>開始日時（JST）</label><input type="datetime-local" name="start" id="start" readonly><label>ホスト（@なし）</label><input name="host" id="host" readonly>
<label class="chk"><input type="checkbox" name="has_recording" value="1" id="rec"> 録音あり（終了後アーカイブに表示）</label>
<label for="recording_url">録音URL（任意）</label><input name="recording_url" id="recording_url" placeholder="https://x.com/i/spaces/… または録音のURL" autocomplete="off">
<div class="hint">X API v2 は録音公開の有無を返さないため、ホスト／登録者が手動で設定します。終了後でも「編集」から変更できます。</div></div></div>
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
.catch(function(e){ok=false;ro(false);var msg=(e&&e.error)||'取得に失敗しました';if(e&&e.reauth){st.innerHTML='⚠️ '+msg+' <a href="/login">再ログイン</a>';}else{st.textContent='⚠️ '+msg+' 手入力もできます';}pv();return false})}
u.addEventListener('change',load);u.addEventListener('blur',load);u.addEventListener('paste',function(){setTimeout(load,0)});
f.addEventListener('submit',function(e){if(u.value.trim()!==last){e.preventDefault();load().then(function(){f.submit()})}});})()</script>`)));
app.post('/new', auth, async (req, res) => {
  const id = await resolveSpaceId(req.body.url); if (!id) return res.status(400).send(page(req, '<div class="msg">スペースIDが見つかりませんでした。URLを確認してください。 <a class="btn" href="/new">戻る</a></div>'));
  let { title, host, start } = req.body, avatar = null; let startIso = start ? new Date(start + '+09:00').toISOString() : null;
  let spaceState = null, endedAt = null, apiRec = false;
  try { const sp = DEMO ? demoSpace(id) : await lookupSpaceForReq(req, id);
    if (sp) { title = title || sp.title; startIso = startIso || sp.scheduled_start; host = host || sp.host; avatar = sp.avatar || null; spaceState = sp.state || null; endedAt = sp.ended_at || null; if (sp.has_recording) apiRec = true; } } catch (e) { console.warn('space lookup failed', e.status || '', (e.message || '').slice(0, 120)); }
  if (!avatar && !DEMO && (host || req.session.user.username)) try { const tok = await ensureAccessToken(req); if (tok) { const r = await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(host || req.session.user.username)}?user.fields=profile_image_url`, { headers: { Authorization: 'Bearer ' + tok } }); avatar = (await r.json()).data?.profile_image_url || null; } } catch {}
  if (!title || !startIso) return res.status(400).send(page(req, '<div class="msg">タイトルと開始日時を取得できませんでした。「編集」から手入力してください。 <a class="btn" href="/new">戻る</a></div>'));
  const hasRec = (req.body.has_recording === '1' || req.body.has_recording === 'on' || apiRec) ? 1 : 0;
  let recUrl = String(req.body.recording_url || '').trim() || null;
  if (recUrl && !/^https?:\/\//i.test(recUrl)) recUrl = null;
  await db.prepare('INSERT INTO spaces(space_id,url,title,host,avatar,start_at,owner_id,has_recording,recording_url,space_state,ended_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, `https://x.com/i/spaces/${id}`, title, (host || req.session.user.username).replace(/^@/, ''), avatar, startIso, req.session.user.id, hasRec, recUrl, spaceState, endedAt);
  res.redirect('/');
});
app.post('/spaces/:id/remind', auth, async (req, res) => {
  const u = req.session.user.id, id = +req.params.id;
  if (await db.prepare('SELECT 1 FROM reminders WHERE user_id=? AND space_row=?').get(u, id)) await db.prepare('DELETE FROM reminders WHERE user_id=? AND space_row=?').run(u, id);
  else await db.prepare('INSERT INTO reminders(user_id,space_row) VALUES(?,?)').run(u, id);
  res.redirect(boardBack(req.body.back));
});
app.get('/spaces/:id.ics', async (req, res) => {
  const s = await db.prepare('SELECT * FROM spaces WHERE id=?').get(+req.params.id); if (!s) return res.sendStatus(404);
  const d = x => new Date(x).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const link = spaceOpenUrl(s);
  res.type('text/calendar').attachment(`space-${s.id}.ics`).send(['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SpacesBoard//JA','BEGIN:VEVENT',`UID:space-${s.id}@spaces-board`,`DTSTAMP:${d(Date.now())}`,`DTSTART:${d(s.start_at)}`,`DTEND:${d(new Date(s.start_at).getTime()+3600e3)}`,`SUMMARY:${s.title.replace(/[,;\n]/g,' ')}`,`URL:${link}`,`DESCRIPTION:${link}`,'BEGIN:VALARM','TRIGGER:-PT15M','ACTION:DISPLAY','DESCRIPTION:スペース開始15分前','END:VALARM','END:VEVENT','END:VCALENDAR'].join('\r\n'));
});
app.post('/spaces/:id/delete', auth, async (req, res) => {
  if (!csrfOk(req)) return res.status(403).send('CSRF error');
  const s = await db.prepare('SELECT owner_id FROM spaces WHERE id=?').get(+req.params.id); if (!s) return res.redirect('/');
  if (s.owner_id !== req.session.user.id && !req.isAdmin) return res.sendStatus(403);
  await db.prepare('DELETE FROM reminders WHERE space_row=?').run(+req.params.id); await db.prepare('DELETE FROM spaces WHERE id=?').run(+req.params.id);
  res.redirect(req.body.back === 'admin' ? '/admin?tab=spaces' : boardBack(req.body.back));
});
// ---- Edit space (owner / admin): mark recording, fix metadata ----
app.get('/spaces/:id/edit', auth, async (req, res) => {
  const s = await db.prepare('SELECT * FROM spaces WHERE id=?').get(+req.params.id); if (!s) return res.status(404).send(page(req, '<div class="msg">見つかりません。</div>'));
  if (s.owner_id !== req.session.user.id && !req.isAdmin) return res.status(403).send(page(req, '<div class="msg">403 · 登録者または管理者のみ編集できます。</div>'));
  const startLocal = (() => { const d = new Date(new Date(s.start_at).getTime() + 9 * 36e5); return d.toISOString().slice(0, 16); })();
  res.send(page(req, `${NEWCSS}<h2><b>スペースを編集</b></h2><form class="form" method="post" action="/spaces/${s.id}/edit">
${csrfIn(req)}
<label>タイトル</label><input name="title" value="${esc(s.title)}" required>
<label>開始日時（JST）</label><input type="datetime-local" name="start" value="${esc(startLocal)}" required>
<label>ホスト（@なし）</label><input name="host" value="${esc(s.host || '')}">
<label class="chk"><input type="checkbox" name="has_recording" value="1" ${+s.has_recording ? 'checked' : ''}> 録音あり（過去のアーカイブに表示）</label>
<label>録音URL（任意）</label><input name="recording_url" value="${esc(s.recording_url || '')}" placeholder="https://…">
<div class="hint">X API は録音の有無を返さないため、ここで手動設定します。終了済み＋録音ありのときだけアーカイブタブに出ます。</div>
<div class="acts"><button class="btn pri">保存する</button><a class="btn" href="/">キャンセル</a>
<button class="btn" formaction="/spaces/${s.id}/refresh" formmethod="post">↻ Xから状態を更新</button></div></form>`));
});
app.post('/spaces/:id/edit', auth, async (req, res) => {
  if (!csrfOk(req)) return res.status(403).send('CSRF error');
  const s = await db.prepare('SELECT * FROM spaces WHERE id=?').get(+req.params.id); if (!s) return res.redirect('/');
  if (s.owner_id !== req.session.user.id && !req.isAdmin) return res.sendStatus(403);
  const title = String(req.body.title || '').trim(); const host = String(req.body.host || '').replace(/^@/, '').trim();
  const startIso = req.body.start ? new Date(req.body.start + '+09:00').toISOString() : null;
  if (!title || !startIso) return res.status(400).send(page(req, '<div class="msg">タイトルと開始日時は必須です。 <a class="btn" href="/spaces/' + s.id + '/edit">戻る</a></div>'));
  const hasRec = req.body.has_recording === '1' || req.body.has_recording === 'on' ? 1 : 0;
  let recUrl = String(req.body.recording_url || '').trim() || null;
  if (recUrl && !/^https?:\/\//i.test(recUrl)) recUrl = null;
  const canon = s.space_id ? `https://x.com/i/spaces/${s.space_id}` : spaceOpenUrl({ ...s, url: s.url });
  await db.prepare('UPDATE spaces SET title=?, host=?, start_at=?, has_recording=?, recording_url=?, url=? WHERE id=?').run(title, host || s.host, startIso, hasRec, recUrl, canon, s.id);
  res.redirect(hasRec && isPast({ ...s, start_at: startIso, has_recording: hasRec }) ? '/?tab=archive' : '/');
});
app.post('/spaces/:id/refresh', auth, async (req, res) => {
  if (!csrfOk(req)) return res.status(403).send('CSRF error');
  const s = await db.prepare('SELECT * FROM spaces WHERE id=?').get(+req.params.id); if (!s) return res.redirect('/');
  if (s.owner_id !== req.session.user.id && !req.isAdmin) return res.sendStatus(403);
  if (DEMO) return res.redirect('/spaces/' + s.id + '/edit');
  try {
    const sp = await lookupSpaceForReq(req, s.space_id);
    const patch = { space_state: sp.state || s.space_state, ended_at: sp.ended_at || s.ended_at, title: s.title || sp.title, host: s.host || sp.host };
    // Only auto-set has_recording when API explicitly says so (rare); never clear a manual flag.
    let hasRec = +s.has_recording; if (sp.has_recording === true) hasRec = 1;
    await db.prepare('UPDATE spaces SET space_state=?, ended_at=?, title=COALESCE(NULLIF(?,\'\'), title), host=COALESCE(NULLIF(?,\'\'), host), avatar=COALESCE(?, avatar), has_recording=? WHERE id=?')
      .run(patch.space_state, patch.ended_at, sp.title || '', sp.host || '', sp.avatar || null, hasRec, s.id);
  } catch (e) { console.warn('refresh failed', e.message); }
  res.redirect('/spaces/' + s.id + '/edit');
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
    return `<tr><td><a class="uc hostlink" href="${esc(boardHref('upcoming', u.username))}" title="@${esc(u.username)} のスペースを表示" aria-label="@${esc(u.username)} のホストスペースを表示">${av(u.username, u.avatar)}<div><div class="n">${esc(u.name || '')}</div><div class="h">@${esc(u.username)}</div></div></a></td>
<td><span class="chip ${r === 'admin' ? '' : 's'}">${r === 'admin' ? '🛡 管理者' : '👤 ユーザー'}${fixed ? '（固定）' : ''}</span></td>
<td><span class="chip ${u.status === 'banned' ? 'live' : 'ok'}">${u.status === 'banned' ? '⛔ 停止中' : '✓ 有効'}</span></td>
<td>${jst(u.first_login)}</td><td>${jst(u.last_login)}</td><td class="num">${u.login_count || 0}</td><td class="num">${u.spaces}</td>
<td><div class="acts2">${fixed || self ? '<span class="h" style="color:var(--mut);font-size:.78rem">—</span>' : (r === 'admin' ? act(u, 'demote', '👤 ユーザーにする') : act(u, 'promote', '🛡 管理者にする')) + (u.status === 'banned' ? act(u, 'unban', '✓ 停止解除') : act(u, 'ban', '⛔ 停止', 'dng'))}</div></td></tr>`; };
  const srow = s => `<tr><td class="tl"><a href="${esc(spaceOpenUrl(s))}" target="_blank" rel="noopener"><b>${esc(s.title)}</b></a></td><td><a href="${esc(boardHref('upcoming', String(s.host||'').replace(/^@/,'')))}">@${esc(s.host)}</a></td><td>${jst(s.start_at)}</td><td>${+s.has_recording ? '🎙 あり' : '—'}</td><td>@${esc(s.owner || '')}</td><td>${jst(s.created_at)}</td>
<td><form method="post" action="/spaces/${s.id}/delete" onsubmit="return confirm('削除しますか？')">${csrfIn(req)}<input type="hidden" name="back" value="admin"><button class="btn dng" style="padding:5px 10px;font-size:.78rem">🗑 削除</button></form></td></tr>`;
  const t = (h, rows) => `<div class="tbl"><table><thead><tr>${h.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${h.length}" style="text-align:center;color:var(--mut)">該当なし</td></tr>`}</tbody></table></div>`;
  res.send(page(req, `${ADMCSS}<h2><b>🛡 管理画面</b> · ログインしたXアカウントとスペースの管理</h2>
<div class="stat"><div><b>${allU.length}</b><span>ユーザー</span></div><div><b>${allU.filter(u => roleOf(u) === 'admin').length}</b><span>管理者</span></div><div><b>${allU.filter(u => u.status === 'banned').length}</b><span>停止中</span></div><div><b>${(await db.prepare('SELECT count(*)::int n FROM spaces WHERE demo=0').get()).n}</b><span>スペース</span></div></div>
<div class="tabs"><a class="btn ${tab === 'users' ? 'on' : ''}" href="/admin?tab=users">👥 ユーザー</a><a class="btn ${tab === 'spaces' ? 'on' : ''}" href="/admin?tab=spaces">🎙 スペース</a>
<form class="srch" method="get" action="/admin"><input type="hidden" name="tab" value="${tab}"><input name="q" value="${esc(q)}" placeholder="🔍 検索（ユーザー名・名前・タイトル）"><button class="btn">検索</button></form><span class="sp"></span>
<a class="btn pri" href="/admin/${tab}.csv">⬇ CSVダウンロード</a></div>
${tab === 'users' ? t(['アカウント', '権限', '状態', '初回ログイン (JST)', '最終ログイン (JST)', 'ログイン回数', '登録数', '操作'], users.map(urow).join('')) : t(['タイトル', 'ホスト', '開始 (JST)', '録音', '登録者', '登録日時 (JST)', '操作'], spaces.map(srow).join(''))}`));
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
  sendCsv(res, 'spaces.csv', ['ID', 'スペースID', 'タイトル', 'ホスト', '開始(JST)', 'URL', '録音あり', '録音URL', '状態', '登録者', '登録日時(JST)'], rows.map(s => [s.id, s.space_id, s.title, s.host, jst(s.start_at), s.url, +s.has_recording ? 'yes' : 'no', s.recording_url || '', s.space_state || '', s.owner, jst(s.created_at)])); });
app.get('/healthz', (req, res) => res.json({ ok: true, demo: DEMO, push: PUSH_READY }));
app.post('/api/push/subscribe', auth, async (req, res) => {
  if (!PUSH_READY) return res.status(503).json({ error: 'push not configured' });
  const sub = req.body || {};
  const endpoint = String(sub.endpoint || '');
  const p256dh = String(sub.keys?.p256dh || '');
  const authk = String(sub.keys?.auth || '');
  if (!endpoint.startsWith('https://') || !p256dh || !authk) return res.status(400).json({ error: 'bad subscription' });
  await db.prepare(`INSERT INTO push_subs(endpoint,user_id,p256dh,auth) VALUES(?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`).run(endpoint, req.session.user.id, p256dh, authk);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth, async (req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  if (endpoint) await db.prepare('DELETE FROM push_subs WHERE endpoint=? AND user_id=?').run(endpoint, req.session.user.id);
  res.json({ ok: true });
});
function jstHM(iso) {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
}
async function runReminderJob() {
  // Due: within minutes_before of start, or already started but still in the live window (< start+1h),
  // and not ended / not older than ~2h (so a slept free-tier instance can still notify on wake).
  const due = await db.prepare(`SELECT r.user_id, r.space_row, r.minutes_before, s.title, s.start_at, s.space_id, s.url, s.space_state, u.username
    FROM reminders r JOIN spaces s ON s.id=r.space_row JOIN users u ON u.id=r.user_id
    WHERE r.sent=0
      AND COALESCE(s.space_state,'') NOT IN ('ended','canceled')
      AND s.start_at > now() - interval '2 hours'
      AND (
        s.start_at - make_interval(mins => COALESCE(r.minutes_before,15)) <= now()
        OR (s.start_at <= now() AND s.start_at > now() - interval '1 hour')
      )`).all();
  let sent = 0, missing = 0, failed = 0;
  for (const row of due) {
    const open = spaceOpenUrl(row);
    const startMs = new Date(row.start_at).getTime();
    const live = startMs <= Date.now();
    const body = live ? 'LIVE中です' : `もう${jstHM(row.start_at)}に始まります`;
    const payload = JSON.stringify({ title: row.title || 'Spaces Board', body, url: open, tag: 'space-' + row.space_row });
    const subs = PUSH_READY ? await db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id=?').all(row.user_id) : [];
    if (!subs.length) { console.log('[reminder] no push sub for', row.username, row.space_row); missing++; }
    for (const sub of subs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600, urgency: 'high' });
        sent++;
      } catch (e) {
        failed++;
        const code = e.statusCode;
        console.warn('[reminder] push fail', code || e.message);
        if (code === 404 || code === 410) await db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(sub.endpoint);
      }
    }
    // Always mark sent after attempt so we don't loop (even with no subscription).
    await db.prepare('UPDATE reminders SET sent=1 WHERE user_id=? AND space_row=?').run(row.user_id, row.space_row);
  }
  await pool.query('DELETE FROM sessions WHERE expire<now()');
  await pool.query(`UPDATE spaces SET space_state='ended', ended_at=COALESCE(ended_at, start_at + interval '1 hour')
    WHERE COALESCE(space_state,'') NOT IN ('ended','canceled') AND start_at < now() - interval '3 hours'`);
  return { due: due.length, sent, missing, failed };
}
const cronAuth = req => {
  const h = String(req.headers.authorization || '');
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  return !!(CRON_SECRET && got && got.length === CRON_SECRET.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(CRON_SECRET)));
};
app.post('/internal/reminders', async (req, res) => {
  if (!cronAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try { res.json({ ok: true, ...(await runReminderJob()) }); }
  catch (e) { console.error('reminder job', e.message); res.status(500).json({ error: 'job failed' }); }
});
app.get('/internal/reminders', async (req, res) => {
  if (!cronAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try { res.json({ ok: true, ...(await runReminderJob()) }); }
  catch (e) { console.error('reminder job', e.message); res.status(500).json({ error: 'job failed' }); }
});
setInterval(async () => { try { await runReminderJob(); } catch (e) { console.error('reminder job', e.message); } }, 60e3);
app.listen(PORT, () => console.log(`Spaces Board on ${BASE} (demo=${DEMO}, push=${PUSH_READY})`));
