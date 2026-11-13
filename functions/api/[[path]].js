// Весь API сайта в одном файле (Cloudflare Pages Functions).
// Привязки: DB (D1), FILES (KV), секрет EDIT_PASSWORD.

const MAX_FILE = 25 * 1024 * 1024; // лимит одного значения в KV
const SCHEM_EXT = ['schem', 'litematic', 'schematic', 'nbt'];
const DIMENSIONS = ['overworld', 'nether', 'end'];
const STATUSES = ['todo', 'doing', 'done'];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
const fail = (status, error) => json({ error }, status);

// D1 іноді на мить відмовляє («Network connection lost», «overloaded», «reset»): Cloudflare радить просто повторити.
const D1_TRANSIENT = /network connection lost|overloaded|reset because|storage operation exceeded timeout|internal error|try again|temporarily/i;
async function d1Retry(run) {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= 2 || !D1_TRANSIENT.test(String(e?.message || e))) throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
}

// Хто робить запит. Рахується один раз на запит у onRequest, далі читається звідси.
// resident — житель міста з акаунтом (бачить схематики й завдання), editor — може змінювати,
// admin — увійшов паролем редактора EDIT_PASSWORD під логіном admin і керує акаунтами жителів.
const WHO = new WeakMap();
const NOBODY = { user: null, resident: false, editor: false, admin: false };
const ADMIN = { user: { id: 0, username: 'admin', role: 'admin' }, resident: true, editor: true, admin: true };
const who = (request) => WHO.get(request) || NOBODY;
function authorized(request) {
  return who(request).editor;
}

const SESSION_COOKIE = 'city_session';
const SESSION_DAYS = 60;
const ROLES = ['resident', 'editor'];
const ADMIN_LOGIN = 'admin';
// PBKDF2 на безкоштовному плані Cloudflare: більше ітерацій не влазить у ліміт часу процесора.
const PBKDF2_ITER = 20000;
const LOGIN_FAILS = 8; // після стількох помилок поспіль вхід у цей акаунт закривається на 15 хвилин
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const USERNAME_RE = /^[\p{L}\p{N}_.-]{2,32}$/u;

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return toHex(new Uint8Array(bits));
}
async function hashPassword(password) {
  const salt = randomHex(16);
  return `pbkdf2$${PBKDF2_ITER}$${salt}$${await pbkdf2(password, fromHex(salt), PBKDF2_ITER)}`;
}
async function checkPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored || '').split('$');
  if (kind !== 'pbkdf2' || !hash) return false;
  return sameText(await pbkdf2(password, fromHex(salt), Number(iter)), hash);
}
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// Мітка пароля редактора в сесії адміна: змінив EDIT_PASSWORD у Cloudflare — старі входи адміна зникають.
const adminTag = async (env) => (await sha256('admin:' + env.EDIT_PASSWORD)).slice(0, 32);

async function whoAmI(request, env) {
  // Пароль у заголовку лишився для скриптів і старих вкладок.
  const header = request.headers.get('x-password');
  if (header && env.EDIT_PASSWORD && sameText(header, env.EDIT_PASSWORD)) return ADMIN;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return NOBODY;
  const row = await env.DB.prepare(
    `SELECT s.kind, s.tag, s.expires_at, u.id, u.username, u.role
     FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).bind(await sha256(token)).first();
  if (!row || row.expires_at < Date.now()) return NOBODY;
  if (row.kind === 'admin') {
    return env.EDIT_PASSWORD && row.tag === (await adminTag(env)) ? ADMIN : NOBODY;
  }
  if (!row.id) return NOBODY;
  return {
    user: { id: row.id, username: row.username, role: row.role },
    resident: true, editor: row.role === 'editor', admin: false,
  };
}
const meOut = (w) => ({ user: w.user, editor: w.editor, admin: w.admin });

async function startSession(request, env, kind, userId, tag = '') {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO sessions (token, kind, user_id, tag, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256(token), kind, userId, tag, now + SESSION_DAYS * 86400_000),
  ]);
  return sessionCookie(request, token, SESSION_DAYS * 86400);
}

// Вхід, вихід і зміна свого пароля.
async function auth(request, env, method, action) {
  if (method === 'GET' && !action) return json(meOut(who(request)));

  if (method === 'DELETE' && !action) {
    const token = readCookie(request, SESSION_COOKIE);
    if (token && /^[0-9a-f]{64}$/.test(token)) {
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256(token)).run();
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': sessionCookie(request, '', 0) },
    });
  }

  if (method === 'POST' && !action) {
    const body = await request.json().catch(() => ({}));
    const username = str(body.username, 64);
    const password = String(body.password ?? '').slice(0, 200);
    if (!username || !password) return fail(400, 'Вкажи логін і пароль');
    const now = Date.now();
    const wrong = () => fail(401, 'Неправильний логін або пароль');

    let cookie, me;
    if (username.toLowerCase() === ADMIN_LOGIN) {
      if (!env.EDIT_PASSWORD) return wrong();
      const lock = await env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_lock'").first();
      const st = lock ? JSON.parse(lock.value) : { fails: 0, until: 0 };
      if (st.until > now) return fail(429, 'Забагато спроб. Спробуй за 15 хвилин');
      if (!sameText(password, env.EDIT_PASSWORD)) {
        const fails = st.fails + 1;
        const next = fails >= LOGIN_FAILS ? { fails: 0, until: now + LOGIN_LOCK_MS } : { fails, until: 0 };
        await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('admin_lock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind(JSON.stringify(next)).run();
        return wrong();
      }
      if (st.fails) await env.DB.prepare("DELETE FROM settings WHERE key = 'admin_lock'").run();
      cookie = await startSession(request, env, 'admin', null, await adminTag(env));
      me = ADMIN;
    } else {
      const u = await env.DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
      if (!u) return wrong();
      if (u.locked_until > now) return fail(429, 'Забагато спроб. Спробуй за 15 хвилин');
      if (!(await checkPassword(password, u.pass_hash))) {
        const fails = u.fails + 1;
        await env.DB.prepare('UPDATE users SET fails = ?, locked_until = ? WHERE id = ?')
          .bind(fails >= LOGIN_FAILS ? 0 : fails, fails >= LOGIN_FAILS ? now + LOGIN_LOCK_MS : 0, u.id).run();
        return wrong();
      }
      await env.DB.prepare("UPDATE users SET fails = 0, locked_until = 0, last_login = datetime('now') WHERE id = ?").bind(u.id).run();
      cookie = await startSession(request, env, 'user', u.id);
      me = { user: { id: u.id, username: u.username, role: u.role }, editor: u.role === 'editor', admin: false };
    }
    return new Response(JSON.stringify(meOut(me)), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie },
    });
  }

  if (method === 'POST' && action === 'password') {
    const w = who(request);
    if (!w.user || w.admin) return fail(401, 'Пароль адміністратора змінюється в Cloudflare (секрет EDIT_PASSWORD)');
    const body = await request.json().catch(() => ({}));
    const u = await env.DB.prepare('SELECT pass_hash FROM users WHERE id = ?').bind(w.user.id).first();
    if (!u || !(await checkPassword(String(body.old ?? ''), u.pass_hash))) return fail(400, 'Старий пароль неправильний');
    const bad = passwordProblem(body.password);
    if (bad) return fail(400, bad);
    await setPassword(env, w.user.id, String(body.password));
    // Інші входи цього жителя закриваються, а новий вхід тут видаємо одразу.
    const cookie = await startSession(request, env, 'user', w.user.id);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie },
    });
  }
  return fail(405, 'Метод не підтримується');
}

function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 6) return 'Пароль має бути щонайменше 6 символів';
  if (p.length > 200) return 'Задовгий пароль';
  return null;
}
async function setPassword(env, userId, password) {
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass_hash = ?, fails = 0, locked_until = 0 WHERE id = ?').bind(await hashPassword(password), userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
  ]);
}

// Акаунти жителів: створює й видаляє лише адміністратор.
const userOut = ({ id, username, role, created_at, last_login }) => ({ id, username, role, created_at, last_login });
async function users(request, env, method, id) {
  if (!who(request).admin) return fail(401, 'Потрібен вхід адміністратора');
  if (!id && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all();
    return json(results.map(userOut));
  }
  const body = method === 'DELETE' ? {} : await request.json().catch(() => ({}));
  if (body.role !== undefined && !ROLES.includes(body.role)) return fail(400, 'Невідома роль');

  if (!id && method === 'POST') {
    const username = str(body.username, 64);
    if (!USERNAME_RE.test(username)) return fail(400, 'Логін: 2–32 літери, цифри, _ . -');
    if (username.toLowerCase() === ADMIN_LOGIN) return fail(400, 'Логін admin зайнятий адміністратором');
    const bad = passwordProblem(body.password);
    if (bad) return fail(400, bad);
    const taken = await env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
    if (taken) return fail(409, 'Такий логін уже є');
    const row = await env.DB.prepare('INSERT INTO users (username, pass_hash, role) VALUES (?, ?, ?) RETURNING *')
      .bind(username, await hashPassword(body.password), body.role || 'resident').first();
    return json(userOut(row), 201);
  }

  const userId = int(id);
  if (userId === null) return fail(400, 'Неправильний id');
  const cur = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!cur) return fail(404, 'Жителя не знайдено');

  if (method === 'PATCH') {
    if (body.password !== undefined) {
      const bad = passwordProblem(body.password);
      if (bad) return fail(400, bad);
      await setPassword(env, userId, body.password);
    }
    if (body.role) await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, userId).run();
    return json(userOut(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()));
  }
  if (method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      env.DB.prepare('UPDATE members SET user_id = NULL WHERE user_id = ?').bind(userId), // профіль у лорі лишається
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
    ]);
    return json({ ok: true });
  }
  return fail(405, 'Метод не підтримується');
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
function int(v) {
  const n = Number(v);
  return Number.isInteger(n) && Math.abs(n) <= 30_000_000 ? n : null;
}

// Жива мапа: мод у грі малює чанки, які прогрузив гравець, і присилає їх сюди.
// Кожен чанк зберігається окремо: картинка 256×256 (16 пікселів на блок) і міні 16×16 для огляду здалеку.
const LIVE_SCHEMA = `CREATE TABLE IF NOT EXISTS live_tiles (
    layer TEXT NOT NULL, cx INTEGER NOT NULL, cz INTEGER NOT NULL,
    hash TEXT NOT NULL, png BLOB NOT NULL, mini BLOB NOT NULL,
    player TEXT DEFAULT '', updated_at INTEGER NOT NULL,
    PRIMARY KEY (layer, cx, cz))`;
const LIVE_MAX_TILES = 24; // за один запит: на безкоштовному плані D1 дозволяє 50 запитів на виклик
const LIVE_MAX_PNG = 400 * 1024;
const LIVE_MAX_BODY = 8 * 1024 * 1024;
const LIVE_MARGIN = 32; // скільки блоків навколо шару мод теж може малювати
const LIVE_MAX_AREAS = 32;
// Усі області шару разом: чанк важить десятки КБ, а база D1 на безкоштовному плані вміщує 500 МБ.
const LIVE_AREA_CHUNKS = 4096;
const MINI_BYTES = 16 * 16 * 4;
// Блоки чанків для 3D: мод присилає їх стиснутими (gzip), сайт зберігає як є, а браузер вставляє в модель міста.
const BLOCKS_SCHEMA = `CREATE TABLE IF NOT EXISTS live_blocks (
    layer TEXT NOT NULL, cx INTEGER NOT NULL, cz INTEGER NOT NULL,
    hash TEXT NOT NULL, data BLOB NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (layer, cx, cz))`;
const BLOCKS_MAX_CHUNK = 256 * 1024; // один чанк стиснутим: зазвичай 1–10 КБ
const BLOCKS_PAGE = 32;              // стільки чанків віддаємо браузеру за раз (менше — щоб влізти в процесор воркера)
const MINIS_PAGE = 512;              // міні чанків за раз
const MODEL_DEFAULT_HEIGHT = 128;    // старі шари не знають висоти свого схематика

// Відвідуваність: кожне відкриття сторінки й розділу — один рядок. vid — випадковий id браузера
// (localStorage), за ним рахуємо унікальних відвідувачів. Ні IP, ні cookie для цього не зберігаємо.
const VISITS_SCHEMA = `CREATE TABLE IF NOT EXISTS visits (
    ts INTEGER NOT NULL, vid TEXT NOT NULL, user TEXT, section TEXT NOT NULL,
    entry INTEGER NOT NULL DEFAULT 0, ref TEXT)`;
const VISIT_SECTIONS = ['map', 'map3d', 'schematics', 'tasks', 'lore'];
const VISITS_KEEP_DAYS = 400;
const BOT_UA = /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|embedly|curl|wget|python/i;

// Таблицы создаются сами при первом запросе, вручную ничего выполнять не нужно.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schematics (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', author TEXT DEFAULT '',
    x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
    dimension TEXT NOT NULL DEFAULT 'overworld',
    file_name TEXT NOT NULL, file_size INTEGER NOT NULL, format TEXT NOT NULL,
    width INTEGER, height INTEGER, length INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo', assignee TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS markers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'other',
    x INTEGER NOT NULL, y INTEGER, z INTEGER NOT NULL, dimension TEXT NOT NULL DEFAULT 'overworld',
    author TEXT DEFAULT '', images TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'resident',
    fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
    last_login TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id INTEGER, tag TEXT DEFAULT '',
    expires_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)',
  LIVE_SCHEMA,
  'CREATE INDEX IF NOT EXISTS live_tiles_updated ON live_tiles (layer, updated_at)',
  BLOCKS_SCHEMA,
  'CREATE INDEX IF NOT EXISTS live_blocks_updated ON live_blocks (layer, updated_at)',
  `CREATE TABLE IF NOT EXISTS lore (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, era TEXT DEFAULT '', body TEXT DEFAULT '',
    pos INTEGER NOT NULL DEFAULT 0, cover TEXT, author TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, nick TEXT DEFAULT '', title TEXT DEFAULT '',
    bio TEXT DEFAULT '', story TEXT DEFAULT '', since TEXT DEFAULT '',
    user_id INTEGER UNIQUE, home_marker INTEGER, skin TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  VISITS_SCHEMA,
  'CREATE INDEX IF NOT EXISTS visits_ts ON visits (ts)',
];
// Типи міток. Підписи й значки задає сайт (app.js), тут лише список дозволених.
const MARKER_KINDS = ['home', 'farm', 'storage', 'mine', 'portal', 'shop', 'danger', 'other'];
// Картинки міток: сайт сам зменшує їх перед завантаженням, тож 3 МБ із запасом. Лежать у KV
// під mimg:<мітка>:<картинка> (і :t для мініатюри), список — у стовпчику images.
const MARKER_IMAGES = 12;
const MARKER_IMAGE_MAX = 3 * 1024 * 1024;
const MARKER_THUMB_MAX = 300 * 1024;
const IMAGE_TYPES = ['image/webp', 'image/jpeg', 'image/png'];

const MAP_TASK_TITLE = 'Завантажити мапу міста';
const MAP_TASK = `Місто під землею, тому звичайна мапа згори (і BlueMap сервера) його не показує. Потрібна мапа зрізу на висоті міста. Способи від найкращого до найпростішого:

СПОСІБ 1. Мапа зі схематика (найкращий)
1. У Litematica виділи все місто: Area Selection, два кути по краях міста, захопи всі поверхи за висотою.
2. Збережи схематик (Save Schematic), файл з’явиться в .minecraft/schematics.
3. Запиши Corner 1 і Corner 2 з Area Editor.
4. На сайті натисни «Увійти», потім на вкладці «Мапа» натисни «Мапа зі схематика».
5. Вибери файл і впиши менші X, Y і Z з двох кутів.
6. Задай зріз: «згори» = трохи нижче за стелю поверху, «знизу» = підлога поверху. Прев’ю покаже, що вийде.
7. Збережи шар. Для кожного поверху можна зробити окремий шар («Поверх 1», «Поверх 2»).

СПОСІБ 2. Xaero's World Map (без схематика)
1. Постав клієнтський мод Xaero's World Map.
2. Відкрий мапу (M), натисни іконку печери внизу ліворуч. Cave Mode Type = Full, а Cave Mode Top Y постав трохи нижче за стелю міста.
3. Пройди все місто, щоб воно промалювалося.
4. Вивантаж мапу в PNG через експорт у меню мапи.
5. На сайті натисни «Завантажити картинку», впиши X і Z лівого верхнього кута картинки та масштаб.

СПОСІБ 3. Через адміна сервера
Попросити додати в BlueMap окрему мапу з render-mask за висотою міста (min-y / max-y) і вимкненим remove-caves-below-y. Тоді підземне місто з’явиться на BlueMap і оновлюватиметься саме.

Файл картинки має бути не більшим за 25 МБ.`;

// Картинки й блоки чанків — це BLOB у D1. Але D1 у воркері передає BLOB масивом чисел (кожен байт —
// окреме число в JSON), і на 1 МБ це ~100 мс процесора. Безкоштовний план дає воркеру ~10 мс, тож
// Cloudflare обривав такі запити з голим «HTTP 503» (помилка 1102). Тому ганяємо байти шістнадцятковим
// рядком: пишемо через unhex(?), читаємо через hex(…). У базі вони так і лежать BLOB.
const HEX_DIGITS = (() => {
  const t = new Uint8Array(512), d = '0123456789abcdef';
  for (let i = 0; i < 256; i++) { t[i * 2] = d.charCodeAt(i >> 4); t[i * 2 + 1] = d.charCodeAt(i & 15); }
  return t;
})();
function toHexStr(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const o = new Uint8Array(b.length * 2);
  for (let i = 0, j = 0; i < b.length; i++, j += 2) { const v = b[i] * 2; o[j] = HEX_DIGITS[v]; o[j + 1] = HEX_DIGITS[v + 1]; }
  return new TextDecoder().decode(o);
}
const nib = (c) => (c <= 57 ? c - 48 : (c | 32) - 87);
// Якщо D1 раптом не знає unhex (старий SQLite), пишемо по-старому, масивом.
let unhexOk = true;
async function batchBlobs(env, make) {
  if (unhexOk) {
    try {
      return await d1Retry(() => env.DB.batch(make(true)));
    } catch (e) {
      if (!/no such function: unhex/i.test(String(e?.message || e))) throw e;
      unhexOk = false;
    }
  }
  return d1Retry(() => env.DB.batch(make(false)));
}
// Із hex(…) приходить рядок; про всяк випадок приймаємо й масив чисел чи ArrayBuffer.
function blobBytes(v) {
  if (v == null) return new Uint8Array(0);
  if (typeof v !== 'string') return new Uint8Array(v);
  const s = new TextEncoder().encode(v), out = new Uint8Array(s.length >> 1);
  for (let i = 0, j = 0; i < out.length; i++, j += 2) out[i] = (nib(s[j]) << 4) | nib(s[j + 1]);
  return out;
}

let schemaReady = null;
function ensureSchema(env) {
  schemaReady ??= (async () => {
    await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
    // Первую задачу кладём ровно один раз, даже если два запроса пришли одновременно.
    const claim = await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('seeded', '1') ON CONFLICT(key) DO NOTHING"
    ).run();
    if (claim.meta.changes === 1) {
      await env.DB.prepare('INSERT INTO tasks (title, description) VALUES (?, ?)')
        .bind(MAP_TASK_TITLE, MAP_TASK).run();
    }
    // Сайт перейшов на українську: один раз перекладаємо перше завдання (якщо його ще ніхто не правив)
    // і шари, названі стандартними російськими назвами з підказок.
    const uk = await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('seeded_uk', '1') ON CONFLICT(key) DO NOTHING"
    ).run();
    if (uk.meta.changes === 1) {
      await env.DB.prepare(
        "UPDATE tasks SET title = ?, description = ? WHERE title = 'Загрузить карту города' AND description LIKE 'Город под землёй%'"
      ).bind(MAP_TASK_TITLE, MAP_TASK).run();
      const names = { 'Подземный город': 'Підземне місто', 'Поверхность': 'Поверхня', 'Этаж 1': 'Поверх 1', 'Этаж 2': 'Поверх 2' };
      const layers = await getLayers(env);
      if (layers.some((l) => names[l.name])) {
        await saveLayers(env, layers.map((l) => ({ ...l, name: names[l.name] || l.name })));
      }
    }
    // Шар міста спершу поставили за прикидкою (кут X −1426, Z −418). Насправді центр міста на X 4250, Z 1550,
    // тож один раз пересуваємо такий шар: центр головного залу схематика (156, 152) лягає на ці координати.
    const moved = await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('city_moved', '1') ON CONFLICT(key) DO NOTHING"
    ).run();
    if (moved.meta.changes === 1) {
      const layers = await getLayers(env);
      const guessed = (l) => l.originX === -1426 && l.originZ === -418;
      if (layers.some(guessed)) {
        await saveLayers(env, layers.map((l) => (guessed(l) ? { ...l, originX: 4094, originZ: 1398 } : l)));
      }
    }
    // Картинки міток з’явилися пізніше за таблицю: додаємо стовпчик, якщо його ще немає.
    const cols = await env.DB.prepare('PRAGMA table_info(markers)').all();
    if (!cols.results.some((c) => c.name === 'images')) {
      await env.DB.prepare("ALTER TABLE markers ADD COLUMN images TEXT NOT NULL DEFAULT '[]'").run()
        .catch((e) => { if (!/duplicate column/i.test(String(e))) throw e; }); // інший запит устиг першим
    }
    // Жива мапа: один раз вмикаємо її для шару міста зі зрізом, з якого намальована мапа.
    const liveOn = await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('live_default', '1') ON CONFLICT(key) DO NOTHING"
    ).run();
    if (liveOn.meta.changes === 1) {
      const layers = await getLayers(env);
      const slice = (l) => {
        if (l.live !== undefined) return null;
        if (Number.isInteger(l.model?.sliceTop) && Number.isInteger(l.model?.sliceBottom)) {
          return { top: l.model.sliceTop, bottom: l.model.sliceBottom };
        }
        // Мапу міста малювали ще до того, як зріз почав зберігатися: −37…−53 підказав сам сайт.
        if (l.originX === 4094 && l.originZ === 1398 && l.model) return { top: -37, bottom: -53 };
        return null;
      };
      if (layers.some(slice)) {
        await saveLayers(env, layers.map((l) => {
          const s = slice(l);
          return s ? { ...l, live: { ...s, epoch: Date.now() } } : l;
        }));
      }
    }
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

export async function onRequest({ request, env, params, waitUntil }) {
  const parts = params.path || [];
  const method = request.method;
  const [section, id, action] = parts;

  if (!env.DB || !env.FILES) {
    return fail(500, 'Сайт не налаштовано: у Cloudflare не прив’язані база DB і сховище FILES');
  }

  try {
    await ensureSchema(env);
    WHO.set(request, await whoAmI(request, env));
    if (section === 'auth') return await auth(request, env, method, id);
    if (section === 'users') return await users(request, env, method, id);
    if (section === 'schematics') return await schematics(request, env, method, id, action);
    if (section === 'tasks') return await tasks(request, env, method, id);
    if (section === 'map') return await map(request, env, method, id, action);
    if (section === 'markers') return await markers(request, env, method, id, action, parts[3]);
    if (section === 'live') return await live(request, env, method, parts, waitUntil);
    if (section === 'colors' && method === 'GET') return json(await getColors(env));
    if (section === 'pack') return await pack(request, env, method, id);
    if (section === 'lore') return await lore(request, env, method, id, action);
    if (section === 'members') return await members(request, env, method, id, action);
    if (section === 'visit' && method === 'POST') return await visit(request, env, waitUntil);
    if (section === 'stats' && method === 'GET') return await stats(request, env);
    if (section === 'skin' && method === 'GET') { // прев’ю скіна за ніком у вікні профілю
      const png = await mojangSkin(env, id);
      return png ? imageResponse(png, 'image/png', `public, max-age=${SKIN_CACHE_S}`) : fail(404, 'Скіна немає');
    }
    return fail(404, 'Не знайдено');
  } catch (e) {
    console.error(e);
    // Тимчасовий збій бази — 503, щоб мод і сторінка знали, що варто повторити. Причину показуємо коротко:
    // без неї з гри не зрозуміти, чому сайт не відповів.
    const why = String(e?.message || e).replace(/\s+/g, ' ').slice(0, 160);
    return fail(D1_TRANSIENT.test(why) ? 503 : 500, `Помилка сервера: ${why}`);
  }
}

// Схематики й завдання бачать лише жителі з акаунтом.
const LOGIN_NEEDED = 'Увійди, щоб бачити схематики й завдання';
async function schematics(request, env, method, id, action) {
  if (!who(request).resident) return fail(401, LOGIN_NEEDED);
  if (!id && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM schematics ORDER BY created_at DESC'
    ).all();
    return json(results);
  }

  if (!id && method === 'POST') {
    if (!authorized(request)) return fail(401, 'Потрібні права редактора');
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return fail(400, 'Не вибрано файл');
    if (file.size > MAX_FILE) return fail(400, 'Файл більший за 25 МБ');
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!SCHEM_EXT.includes(ext)) return fail(400, 'Підтримуються .schem, .litematic, .schematic, .nbt');

    const name = str(form.get('name'), 120);
    const x = int(form.get('x')), y = int(form.get('y')), z = int(form.get('z'));
    if (!name) return fail(400, 'Вкажи назву');
    if (x === null || y === null || z === null) return fail(400, 'Координати мають бути цілими числами');
    const dimension = DIMENSIONS.includes(form.get('dimension')) ? form.get('dimension') : 'overworld';

    const newId = crypto.randomUUID();
    await env.FILES.put(`schem:${newId}`, await file.arrayBuffer());
    await env.DB.prepare(
      `INSERT INTO schematics (id, name, description, author, x, y, z, dimension, file_name, file_size, format, width, height, length)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      newId, name, str(form.get('description'), 2000), str(form.get('author'), 60),
      x, y, z, dimension, str(file.name, 200), file.size, ext,
      int(form.get('width')), int(form.get('height')), int(form.get('length'))
    ).run();
    return json({ id: newId }, 201);
  }

  if (!id) return fail(405, 'Метод не підтримується');
  const row = await env.DB.prepare('SELECT * FROM schematics WHERE id = ?').bind(id).first();
  if (!row) return fail(404, 'Схематик не знайдено');

  if (method === 'GET' && action === 'file') {
    const data = await env.FILES.get(`schem:${id}`, 'arrayBuffer');
    if (!data) return fail(404, 'Файл не знайдено');
    const url = new URL(request.url);
    const inline = url.searchParams.has('preview');
    return new Response(data, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': inline
          ? 'inline'
          : `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
        'cache-control': 'private, max-age=86400',
      },
    });
  }
  if (method === 'GET') return json(row);

  if (method === 'DELETE') {
    if (!authorized(request)) return fail(401, 'Потрібні права редактора');
    await env.FILES.delete(`schem:${id}`);
    await env.DB.prepare('DELETE FROM schematics WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  return fail(405, 'Метод не підтримується');
}

async function tasks(request, env, method, id) {
  if (!who(request).resident) return fail(401, LOGIN_NEEDED);
  if (!id && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM tasks ORDER BY id').all();
    return json(results);
  }
  if (!authorized(request)) return fail(401, 'Потрібні права редактора');

  if (!id && method === 'POST') {
    const body = await request.json();
    const title = str(body.title, 200);
    if (!title) return fail(400, 'Вкажи назву завдання');
    const status = STATUSES.includes(body.status) ? body.status : 'todo';
    const res = await env.DB.prepare(
      'INSERT INTO tasks (title, description, status, assignee) VALUES (?, ?, ?, ?) RETURNING *'
    ).bind(title, str(body.description, 5000), status, str(body.assignee, 60)).first();
    return json(res, 201);
  }

  const taskId = int(id);
  if (taskId === null) return fail(400, 'Неправильний id');

  if (method === 'PATCH') {
    const body = await request.json();
    const cur = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
    if (!cur) return fail(404, 'Завдання не знайдено');
    const next = {
      title: body.title !== undefined ? str(body.title, 200) || cur.title : cur.title,
      description: body.description !== undefined ? str(body.description, 5000) : cur.description,
      status: STATUSES.includes(body.status) ? body.status : cur.status,
      assignee: body.assignee !== undefined ? str(body.assignee, 60) : cur.assignee,
    };
    const res = await env.DB.prepare(
      `UPDATE tasks SET title = ?, description = ?, status = ?, assignee = ?, updated_at = datetime('now')
       WHERE id = ? RETURNING *`
    ).bind(next.title, next.description, next.status, next.assignee, taskId).first();
    return json(res);
  }

  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(taskId).run();
    return json({ ok: true });
  }
  return fail(405, 'Метод не підтримується');
}

// Мітки на мапі: «Ферма заліза», «Склад», «Портал у Незер». Дивитися може кожен, ставити лише редактор.
const markerOut = (row) => {
  let images = [];
  try { images = JSON.parse(row.images || '[]'); } catch { /* зіпсований список: без картинок */ }
  return { ...row, images: Array.isArray(images) ? images : [] };
};
async function markers(request, env, method, id, action, imageId) {
  if (!id && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM markers ORDER BY name COLLATE NOCASE').all();
    return json(results.map(markerOut));
  }
  if (action === 'images') return markerImages(request, env, method, id, imageId);
  if (!authorized(request)) return fail(401, 'Потрібні права редактора');

  const body = method === 'DELETE' ? {} : await request.json().catch(() => null);
  if (!body) return fail(400, 'Не вдалося прочитати мітку');
  const optInt = (v) => (v === null || v === '' || v === undefined ? null : int(v));
  const read = (cur = {}) => {
    const has = (k) => body[k] !== undefined;
    const m = {
      name: has('name') ? str(body.name, 60) : cur.name,
      description: has('description') ? str(body.description, 1000) : cur.description ?? '',
      kind: has('kind') ? body.kind : cur.kind ?? 'other',
      x: has('x') ? int(body.x) : cur.x,
      y: has('y') ? optInt(body.y) : cur.y ?? null,
      z: has('z') ? int(body.z) : cur.z,
      dimension: has('dimension') ? body.dimension : cur.dimension ?? 'overworld',
      author: has('author') ? str(body.author, 60) : cur.author ?? '',
    };
    if (!m.name) return 'Вкажи назву мітки';
    if (!MARKER_KINDS.includes(m.kind)) return 'Невідомий тип мітки';
    if (m.x === null || m.x === undefined || m.z === null || m.z === undefined) return 'Вкажи X і Z';
    if (has('y') && body.y !== null && body.y !== '' && m.y === null) return 'Y має бути цілим числом';
    if (!DIMENSIONS.includes(m.dimension)) return 'Невідомий вимір';
    return m;
  };

  if (!id && method === 'POST') {
    const m = read();
    if (typeof m === 'string') return fail(400, m);
    const row = await env.DB.prepare(
      `INSERT INTO markers (name, description, kind, x, y, z, dimension, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(m.name, m.description, m.kind, m.x, m.y, m.z, m.dimension, m.author).first();
    return json(markerOut(row), 201);
  }

  const markerId = Number(id);
  if (!Number.isInteger(markerId)) return fail(404, 'Мітку не знайдено');
  const cur = await env.DB.prepare('SELECT * FROM markers WHERE id = ?').bind(markerId).first();
  if (!cur) return fail(404, 'Мітку не знайдено');

  if (method === 'PATCH') {
    const m = read(cur);
    if (typeof m === 'string') return fail(400, m);
    const row = await env.DB.prepare(
      `UPDATE markers SET name = ?, description = ?, kind = ?, x = ?, y = ?, z = ?, dimension = ?, author = ?,
       updated_at = datetime('now') WHERE id = ? RETURNING *`
    ).bind(m.name, m.description, m.kind, m.x, m.y, m.z, m.dimension, m.author, markerId).first();
    return json(markerOut(row));
  }
  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM markers WHERE id = ?').bind(markerId).run();
    await Promise.all(markerOut(cur).images.flatMap((im) => [
      env.FILES.delete(`mimg:${markerId}:${im.id}`), env.FILES.delete(`mimg:${markerId}:${im.id}:t`),
    ]));
    return json({ ok: true });
  }
  return fail(405, 'Метод не підтримується');
}

// Картинки мітки: GET /markers/:id/images/:img (?t — мініатюра) для всіх, POST і DELETE для редактора.
async function markerImages(request, env, method, id, imageId) {
  const markerId = Number(id);
  if (!Number.isInteger(markerId)) return fail(404, 'Мітку не знайдено');
  if (imageId !== undefined && !/^[0-9a-f]{12}$/.test(imageId)) return fail(404, 'Картинку не знайдено');
  if ((method === 'GET' || method === 'HEAD') && imageId) {
    const thumb = new URL(request.url).searchParams.has('t');
    let { value, metadata } = await env.FILES.getWithMetadata(`mimg:${markerId}:${imageId}${thumb ? ':t' : ''}`, 'arrayBuffer');
    if (!value && thumb) ({ value, metadata } = await env.FILES.getWithMetadata(`mimg:${markerId}:${imageId}`, 'arrayBuffer'));
    if (!value) return fail(404, 'Картинку не знайдено');
    return new Response(value, {
      headers: {
        'content-type': metadata?.type || 'image/webp', 'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=31536000, immutable', // id картинки ніколи не повторюється
      },
    });
  }
  if (!authorized(request)) return fail(401, 'Потрібні права редактора');
  const cur = await env.DB.prepare('SELECT * FROM markers WHERE id = ?').bind(markerId).first();
  if (!cur) return fail(404, 'Мітку не знайдено');
  const images = markerOut(cur).images;
  const tooMany = () => fail(400, `До однієї мітки можна додати до ${MARKER_IMAGES} картинок`);

  if (method === 'POST' && !imageId) {
    if (images.length >= MARKER_IMAGES) return tooMany();
    const form = await request.formData().catch(() => null);
    const file = form?.get('image'), thumb = form?.get('thumb');
    if (!file || typeof file === 'string' || !file.size) return fail(400, 'Не вибрано картинку');
    if (!IMAGE_TYPES.includes(file.type)) return fail(400, 'Потрібна картинка PNG, JPG або WebP');
    if (file.size > MARKER_IMAGE_MAX) return fail(400, 'Картинка більша за 3 МБ');
    const hasThumb = thumb && typeof thumb !== 'string' && thumb.size && thumb.size <= MARKER_THUMB_MAX && IMAGE_TYPES.includes(thumb.type);
    const w = int(form.get('width')), h = int(form.get('height'));
    const im = { id: crypto.randomUUID().replaceAll('-', '').slice(0, 12), type: file.type, size: file.size, w: w > 0 ? w : null, h: h > 0 ? h : null };
    const key = `mimg:${markerId}:${im.id}`;
    await env.FILES.put(key, await file.arrayBuffer(), { metadata: { type: file.type } });
    if (hasThumb) await env.FILES.put(key + ':t', await thumb.arrayBuffer(), { metadata: { type: thumb.type } });
    // Додаємо в список одним запитом, щоб дві одночасні картинки не затерли одна одну.
    const row = await env.DB.prepare(
      `UPDATE markers SET images = json_insert(images, '$[#]', json(?)), updated_at = datetime('now')
       WHERE id = ? AND json_array_length(images) < ? RETURNING *`
    ).bind(JSON.stringify(im), markerId, MARKER_IMAGES).first();
    if (!row) {
      await Promise.all([env.FILES.delete(key), env.FILES.delete(key + ':t')]);
      return tooMany();
    }
    return json({ ...markerOut(row), image: im }, 201);
  }
  if (method === 'DELETE' && imageId) {
    if (!images.some((im) => im.id === imageId)) return fail(404, 'Картинку не знайдено');
    const row = await env.DB.prepare(
      `UPDATE markers SET updated_at = datetime('now'), images = (
         SELECT json_group_array(json(value)) FROM json_each(markers.images) WHERE json_extract(value, '$.id') IS NOT ?
       ) WHERE id = ? RETURNING *`
    ).bind(imageId, markerId).first();
    await Promise.all([env.FILES.delete(`mimg:${markerId}:${imageId}`), env.FILES.delete(`mimg:${markerId}:${imageId}:t`)]);
    return row ? json(markerOut(row)) : fail(404, 'Мітку не знайдено');
  }
  return fail(405, 'Метод не підтримується');
}

// Слои карты: например «Поверхность» и «Подземный город». Список хранится в settings.maps,
// картинка каждого слоя лежит в KV под ключом map:<id>.
async function getLayers(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'maps'").first();
  return row ? JSON.parse(row.value) : [];
}
async function saveLayers(env, layers) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('maps', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(JSON.stringify(layers)).run();
}

// Середні кольори блоків (верх і бік), пораховані в браузері з текстур гри. Ними фарбується 3D.
// Самі текстури на сайт не потрапляють.
async function getColors(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'block_colors'").first();
  return row ? JSON.parse(row.value) : {};
}
async function mergeColors(env, raw) {
  if (raw.length > 200_000) return;
  let incoming;
  try { incoming = JSON.parse(raw); } catch { return; }
  if (!incoming || typeof incoming !== 'object') return;
  const colors = await getColors(env);
  const hex = /^#[0-9a-f]{6}$/;
  for (const [name, pair] of Object.entries(incoming)) {
    if (/^[a-z0-9_.-]{1,40}:[a-z0-9_./-]{1,80}$/.test(name) && Array.isArray(pair) && pair.length === 2 && pair.every((c) => hex.test(c))) {
      colors[name] = pair;
    }
  }
  const all = Object.entries(colors).slice(-3000); // з запасом на моди
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('block_colors', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(JSON.stringify(Object.fromEntries(all))).run();
}

async function map(request, env, method, id, action) {
  if (method === 'GET' && !id) return json(await getLayers(env));

  if (method === 'GET' && action === 'model') {
    const data = await env.FILES.get(`model:${id}`, 'arrayBuffer');
    if (!data) return fail(404, 'У цього шару немає 3D-моделі');
    return new Response(data, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' },
    });
  }

  if (method === 'GET' && action === 'image') {
    const { value, metadata } = await env.FILES.getWithMetadata(`map:${id}`, 'arrayBuffer');
    if (!value) return fail(404, 'Картинку шару не знайдено');
    return new Response(value, {
      headers: {
        'content-type': metadata?.type || 'image/png',
        'cache-control': 'public, max-age=31536000, immutable', // в адресе есть версия
      },
    });
  }

  if (!authorized(request)) return fail(401, 'Потрібні права редактора');

  if (method === 'POST' && !id) {
    const form = await request.formData();
    const layers = await getLayers(env);
    const replaceId = str(form.get('layerId'), 64);
    const existing = replaceId ? layers.find((l) => l.id === replaceId) : null;
    if (replaceId && !existing) return fail(404, 'Шар не знайдено');

    const name = str(form.get('name'), 60) || existing?.name;
    if (!name) return fail(400, 'Вкажи назву шару');
    const dimension = DIMENSIONS.includes(form.get('dimension')) ? form.get('dimension') : 'overworld';
    const originX = int(form.get('originX')), originZ = int(form.get('originZ'));
    const scale = Number(form.get('scale'));
    if (originX === null || originZ === null) return fail(400, 'Вкажи X і Z лівого верхнього кута');
    // Карта з текстурами має 16 пікселів на блок, тобто масштаб 1/16.
    if (!(scale >= 1 / 64 && scale <= 64)) return fail(400, 'Масштаб від 1/64 до 64 блоків на піксель');

    const file = form.get('image');
    const hasFile = file && typeof file !== 'string' && file.size > 0;
    if (!hasFile && !existing) return fail(400, 'Не вибрано картинку');
    let { width, height } = existing || {};
    if (hasFile) {
      if (file.size > MAX_FILE) return fail(400, 'Картинка більша за 25 МБ, збережи її в JPG або WebP');
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return fail(400, 'Потрібен PNG, JPG або WebP');
      width = int(form.get('width'));
      height = int(form.get('height'));
      if (!width || !height) return fail(400, 'Не вдалося прочитати розмір картинки');
    }

    // 3D-модель: схематик, из которого нарисована картинка. Хранится рядом со слоем.
    const model = form.get('model');
    const hasModel = model && typeof model !== 'string' && model.size > 0;
    let modelInfo = existing?.model || null;
    if (hasModel) {
      if (model.size > MAX_FILE) return fail(400, 'Схематик для 3D більший за 25 МБ');
      const ext = (model.name.split('.').pop() || '').toLowerCase();
      if (!['schem', 'litematic'].includes(ext)) return fail(400, 'Для 3D потрібен .schem або .litematic');
      const minY = int(form.get('modelMinY'));
      if (minY === null) return fail(400, 'Вкажи нижню висоту схематика');
      modelInfo = { fileName: str(model.name, 200), format: ext, minY, version: Date.now() };
      const modelHeight = int(form.get('modelHeight'));
      if (modelHeight > 0 && modelHeight <= 4096) modelInfo.height = modelHeight;
      // Зріз, з якого намальована мапа: наступного разу діалог підставить його сам.
      const sliceTop = int(form.get('sliceTop')), sliceBottom = int(form.get('sliceBottom'));
      if (sliceTop !== null && sliceBottom !== null) Object.assign(modelInfo, { sliceTop, sliceBottom });
    } else if (hasFile) {
      modelInfo = null; // новая картинка не из схематика: старая модель больше не совпадает
    }

    const layer = {
      id: existing?.id || crypto.randomUUID().slice(0, 8),
      name, dimension, originX, originZ, scale, width, height,
      version: hasFile ? Date.now() : existing.version,
      model: modelInfo,
      live: existing?.live || null, // налаштування живої мапи не губляться, коли шар перемальовують
      liveAreas: existing?.liveAreas || [],
    };
    if (hasFile) {
      await env.FILES.put(`map:${layer.id}`, await file.arrayBuffer(), { metadata: { type: file.type } });
    }
    if (hasModel) await env.FILES.put(`model:${layer.id}`, await model.arrayBuffer());
    else if (!modelInfo && existing?.model) await env.FILES.delete(`model:${layer.id}`);
    // Новий схематик свіжіший за все, що прислав мод: старі блоки чанків більше не потрібні.
    if (existing && (hasModel || !modelInfo)) await env.DB.prepare('DELETE FROM live_blocks WHERE layer = ?').bind(layer.id).run();
    await saveLayers(env, existing ? layers.map((l) => (l.id === layer.id ? layer : l)) : [...layers, layer]);
    const colors = form.get('colors');
    if (typeof colors === 'string' && colors) await mergeColors(env, colors);
    return json(layer, existing ? 200 : 201);
  }

  if (method === 'DELETE' && id) {
    const layers = await getLayers(env);
    if (!layers.some((l) => l.id === id)) return fail(404, 'Шар не знайдено');
    await env.FILES.delete(`map:${id}`);
    await env.FILES.delete(`model:${id}`);
    await env.DB.prepare('DELETE FROM live_tiles WHERE layer = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM live_blocks WHERE layer = ?').bind(id).run();
    await saveLayers(env, layers.filter((l) => l.id !== id));
    return json({ ok: true });
  }
  return fail(405, 'Метод не підтримується');
}

// ---------- Текстури блоків для 3D ----------
// Редактор кладе на сайт аркуш текстур зі своєї гри (як BlueMap бере їх із гри сервера), і 3D у всіх
// малюється ними. Аркуш збирає браузер редактора: PNG із квадратами 16×16 і опис, де який блок.
const PACK_MAX_PNG = 2 * 1024 * 1024;
const PACK_MAX_TILES = 4096;
async function pack(request, env, method, id) {
  if (method === 'GET' && !id) {
    const meta = await env.FILES.get('pack:meta', 'json');
    if (!meta) return fail(404, 'Текстур на сайті немає');
    return new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (method === 'GET' && id === 'image') {
    const data = await env.FILES.get('pack:image', 'arrayBuffer');
    if (!data) return fail(404, 'Текстур на сайті немає');
    return new Response(data, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' } }); // в адресі версія
  }
  if (!authorized(request)) return fail(401, 'Потрібні права редактора');
  if (method === 'POST' && !id) {
    const form = await request.formData();
    const image = form.get('image');
    if (!image || typeof image === 'string' || !image.size) return fail(400, 'Немає картинки з текстурами');
    if (image.size > PACK_MAX_PNG) return fail(400, 'Завеликий аркуш текстур');
    const bytes = new Uint8Array(await image.arrayBuffer());
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((b, k) => bytes[k] === b)) return fail(400, 'Аркуш текстур має бути PNG');
    let meta;
    try { meta = JSON.parse(String(form.get('meta') || '')); } catch { return fail(400, 'Немає опису текстур'); }
    const cols = int(meta?.cols), entries = Object.entries(meta?.tiles || {});
    if (meta?.size !== 16 || !(cols > 0 && cols <= 256) || !entries.length || entries.length > PACK_MAX_TILES) return fail(400, 'Неправильний опис текстур');
    const tiles = {};
    for (const [name, v] of entries) {
      const i = Array.isArray(v) ? int(v[0]) : null;
      if (!/^[a-z0-9_]{1,80}$/.test(name) || i === null || i < 0 || i >= PACK_MAX_TILES) return fail(400, 'Неправильний опис текстур');
      tiles[name] = v[1] ? [i, 1] : [i];
    }
    const saved = { size: 16, cols, tiles, v: Date.now(), name: str(form.get('name'), 80) };
    await env.FILES.put('pack:image', bytes);
    await env.FILES.put('pack:meta', JSON.stringify(saved));
    return json({ ok: true, v: saved.v, count: entries.length });
  }
  if (method === 'DELETE' && !id) {
    await env.FILES.delete('pack:meta');
    await env.FILES.delete('pack:image');
    return json({ ok: true });
  }
  return fail(405, 'Метод не підтримується');
}

// ---------- Жива мапа ----------
// Де мод малює чанки: прямокутник шару з невеликим запасом і області, які додав редактор.
// Область рівняється до меж чанків і може мати свій зріз за висотою, нижче чи вище за основний.
const layerBox = (l) => ({
  minX: l.originX - LIVE_MARGIN, minZ: l.originZ - LIVE_MARGIN,
  maxX: Math.ceil(l.originX + l.width * l.scale) + LIVE_MARGIN - 1,
  maxZ: Math.ceil(l.originZ + l.height * l.scale) + LIVE_MARGIN - 1,
});
// Коробка 3D-моделі шару у світі: у її межах мод надсилає ще й самі блоки, щоб 3D оновлювалося.
function modelBox(l) {
  if (!l.model) return null;
  return {
    minX: l.originX, minZ: l.originZ,
    maxX: Math.ceil(l.originX + l.width * l.scale) - 1, maxZ: Math.ceil(l.originZ + l.height * l.scale) - 1,
    minY: l.model.minY, maxY: l.model.minY + (l.model.height || MODEL_DEFAULT_HEIGHT) - 1, v: l.model.version,
  };
}
function liveLayers(layers) {
  return layers.filter((l) => l.live).map((l) => ({
    id: l.id, name: l.name, dimension: l.dimension, top: l.live.top, bottom: l.live.bottom, epoch: l.live.epoch || 0,
    ...layerBox(l),
    model: modelBox(l),
    areas: (l.liveAreas || []).map(({ minX, minZ, maxX, maxZ, top, bottom }) => ({ minX, minZ, maxX, maxZ, top, bottom })),
  }));
}
// Межі в чанках, включно: чанк рахується, якщо зачіпає прямокутник хоч краєм.
const chunkBox = (r) => ({
  c0: Math.floor(r.minX / 16), c1: Math.floor(r.maxX / 16), r0: Math.floor(r.minZ / 16), r1: Math.floor(r.maxZ / 16),
});
const inBox = (b, cx, cz) => cx >= b.c0 && cx <= b.c1 && cz >= b.r0 && cz <= b.r1;
const boxesOverlap = (a, b) => a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1;
// Числа вже перевірені, тож їх можна вписати в SQL прямо: D1 приймає не більше 100 параметрів.
const boxSql = (b) => `(cx BETWEEN ${b.c0} AND ${b.c1} AND cz BETWEEN ${b.r0} AND ${b.r1})`;
const areaChunks = (areas) => areas.reduce((n, a) => {
  const b = chunkBox(a);
  return n + (b.c1 - b.c0 + 1) * (b.r1 - b.r0 + 1);
}, 0);
const sliceKey = (x) => `${x.top}:${x.bottom}`;

function readArea(body, old) {
  const read = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : int(v));
  const v = ['minX', 'maxX', 'minZ', 'maxZ', 'top', 'bottom'].map((k) => read(body[k]));
  if (v.some((n) => n === null)) return { error: 'Вкажи межі області й зріз цілими числами' };
  let [x0, x1, z0, z1, top, bottom] = v;
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (z0 > z1) [z0, z1] = [z1, z0];
  if (top < bottom) return { error: 'Зріз згори має бути не нижче за зріз знизу' };
  if (top > 2048 || bottom < -2048) return { error: 'Зріз за межами світу' };
  return {
    area: {
      id: old?.id || crypto.randomUUID().slice(0, 8),
      name: str(body.name, 60),
      // Мод малює цілими чанками, тож і межі рівняємо до чанків.
      minX: Math.floor(x0 / 16) * 16, maxX: Math.floor(x1 / 16) * 16 + 15,
      minZ: Math.floor(z0 / 16) * 16, maxZ: Math.floor(z1 / 16) * 16 + 15,
      top, bottom,
    },
  };
}
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}
// Мод показує ключ, а не пароль редактора: ключ уміє лише надсилати чанки, і його легко замінити.
async function liveKeyOk(request, env) {
  if (authorized(request)) return true;
  const key = request.headers.get('x-live-key');
  if (!key || key.length > 200) return false;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'live_key'").first();
  return !!row && JSON.parse(row.value).hash === (await sha256(key));
}

// Формат від мода (big-endian): "CMT1", u16 кількість, далі для кожного чанка:
// i32 cx, i32 cz, 16 байт хешу, 1024 байти міні (16×16 RGBA), u32 довжина PNG, PNG 256×256.
function parseLiveTiles(buf) {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (buf.byteLength < 6 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'CMT1') throw new Error('Невідомий формат');
  const count = dv.getUint16(4);
  if (count > LIVE_MAX_TILES) throw new Error(`Не більше ${LIVE_MAX_TILES} чанків за раз`);
  const tiles = [];
  let o = 6;
  for (let i = 0; i < count; i++) {
    if (o + 8 + 16 + MINI_BYTES + 4 > buf.byteLength) throw new Error('Обрізаний запит');
    const cx = dv.getInt32(o), cz = dv.getInt32(o + 4);
    const hash = toHex(bytes.subarray(o + 8, o + 24));
    const mini = buf.slice(o + 24, o + 24 + MINI_BYTES);
    o += 24 + MINI_BYTES;
    const n = dv.getUint32(o);
    o += 4;
    if (n > LIVE_MAX_PNG || o + n > buf.byteLength) throw new Error('Завелика картинка чанка');
    const png = bytes.subarray(o, o + n);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    const pv = new DataView(buf, o, n);
    if (n < 24 || sig.some((b, k) => png[k] !== b) || pv.getUint32(16) !== 256 || pv.getUint32(20) !== 256) {
      throw new Error('Картинка чанка має бути PNG 256×256');
    }
    tiles.push({ cx, cz, hash, mini, png: buf.slice(o, o + n) });
    o += n;
  }
  return tiles;
}

async function live(request, env, method, parts, waitUntil) {
  const [, id, action, a, b] = parts;
  if (!id && method === 'GET') return json({ layers: liveLayers(await getLayers(env)) });

  if (id === 'key') {
    if (!authorized(request)) return fail(401, 'Потрібні права редактора');
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'live_key'").first();
    if (method === 'GET') return json({ exists: !!row, createdAt: row ? JSON.parse(row.value).createdAt : null });
    if (method === 'POST') {
      const raw = crypto.getRandomValues(new Uint8Array(18));
      const key = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_');
      const value = JSON.stringify({ hash: await sha256(key), createdAt: Date.now() });
      await env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('live_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(value).run();
      return json({ key });
    }
    return fail(405, 'Метод не підтримується');
  }

  const layers = await getLayers(env);
  const layer = layers.find((l) => l.id === id);
  if (!layer) return fail(404, 'Шар не знайдено');

  // Список чанків шару. ?since=час віддає лише ті, що змінилися відтоді (так сайт і мод питають щохвилини).
  const since = Math.max(0, Number(new URL(request.url).searchParams.get('since')) || 0);
  if (method === 'GET' && !action) {
    const { results } = await env.DB.prepare(
      'SELECT cx, cz, hash, updated_at, player FROM live_tiles WHERE layer = ? AND updated_at >= ?'
    ).bind(id, since).all();
    const blocks = layer.model ? (await env.DB.prepare(
      'SELECT cx, cz, hash, updated_at FROM live_blocks WHERE layer = ? AND updated_at >= ?'
    ).bind(id, since).all()).results : [];
    return new Response(JSON.stringify({
      live: layer.live || null,
      tiles: results.map((r) => [r.cx, r.cz, r.hash, r.updated_at, r.player]),
      blocks: blocks.map((r) => [r.cx, r.cz, r.hash, r.updated_at]),
    }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }

  // Міні всіх чанків одним шматком: i32 cx, i32 cz і 1024 байти RGBA на кожен.
  if (method === 'GET' && action === 'minis') {
    const offset = Math.max(0, int(new URL(request.url).searchParams.get('offset')) || 0);
    const { results } = await env.DB.prepare(
      'SELECT cx, cz, hex(mini) AS mini FROM live_tiles WHERE layer = ? AND updated_at >= ? ORDER BY updated_at, cx, cz LIMIT ? OFFSET ?'
    ).bind(id, since, MINIS_PAGE + 1, offset).all();
    const page = results.slice(0, MINIS_PAGE);
    const size = 8 + MINI_BYTES;
    const out = new Uint8Array(page.length * size);
    const dv = new DataView(out.buffer);
    page.forEach((r, i) => {
      dv.setInt32(i * size, r.cx);
      dv.setInt32(i * size + 4, r.cz);
      out.set(blobBytes(r.mini).subarray(0, MINI_BYTES), i * size + 8);
    });
    return new Response(out, { headers: {
      'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-more': results.length > MINIS_PAGE ? '1' : '0',
    } });
  }

  if (method === 'GET' && action === 'tile') {
    const cx = int(a), cz = int(b);
    if (cx === null || cz === null) return fail(404, 'Чанк не знайдено');
    const want = new URL(request.url).searchParams.get('h');
    const cache = want && typeof caches !== 'undefined' ? caches.default : null;
    const hit = cache && (await cache.match(request).catch(() => null));
    if (hit) return hit;
    const row = await env.DB.prepare('SELECT hex(png) AS png, hash FROM live_tiles WHERE layer = ? AND cx = ? AND cz = ?')
      .bind(id, cx, cz).first();
    if (!row) return fail(404, 'Чанк не знайдено');
    const fresh = want === row.hash; // в адресі хеш, тож таку картинку можна кешувати назавжди
    const res = new Response(blobBytes(row.png), {
      headers: {
        'content-type': 'image/png',
        'cache-control': fresh ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
      },
    });
    if (fresh && cache && waitUntil) waitUntil(cache.put(request, res.clone()).catch(() => {}));
    return res;
  }

  // Блоки чанків для 3D одним шматком: i32 cx, i32 cz, f64 час, u32 довжина і gzip-дані на кожен.
  // Віддаємо сторінками за часом зміни; заголовок x-more каже, що є ще.
  if (method === 'GET' && action === 'blocks') {
    const offset = Math.max(0, int(new URL(request.url).searchParams.get('offset')) || 0);
    const { results } = await env.DB.prepare(
      'SELECT cx, cz, hex(data) AS data, updated_at FROM live_blocks WHERE layer = ? AND updated_at >= ? ORDER BY updated_at, cx, cz LIMIT ? OFFSET ?'
    ).bind(id, since, BLOCKS_PAGE + 1, offset).all();
    const page = results.slice(0, BLOCKS_PAGE).map((r) => ({ ...r, data: blobBytes(r.data) }));
    const out = new Uint8Array(page.reduce((n, r) => n + 20 + r.data.length, 0));
    const dv = new DataView(out.buffer);
    let o = 0;
    for (const r of page) {
      dv.setInt32(o, r.cx); dv.setInt32(o + 4, r.cz); dv.setFloat64(o + 8, r.updated_at); dv.setUint32(o + 16, r.data.length);
      out.set(r.data, o + 20);
      o += 20 + r.data.length;
    }
    return new Response(out, { headers: {
      'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-more': results.length > BLOCKS_PAGE ? '1' : '0',
    } });
  }

  // Мод надсилає блоки чанків: "CMB1", u16 кількість, далі i32 cx, i32 cz, 16 байт хешу, u32 довжина, gzip.
  if (method === 'POST' && action === 'blocks') {
    if (!(await liveKeyOk(request, env))) return fail(401, 'Ключ мода не підходить');
    if (!layer.live) return fail(409, 'Для цього шару жива мапа вимкнена');
    const box = modelBox(layer);
    if (!box) return fail(409, 'У цього шару немає 3D-моделі');
    if (Number(request.headers.get('content-length') || 0) > LIVE_MAX_BODY) return fail(413, 'Завеликий запит');
    const buf = await request.arrayBuffer();
    if (buf.byteLength > LIVE_MAX_BODY) return fail(413, 'Завеликий запит');
    const dv = new DataView(buf), bytes = new Uint8Array(buf);
    if (buf.byteLength < 6 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'CMB1') return fail(400, 'Невідомий формат');
    const count = dv.getUint16(4);
    if (count > LIVE_MAX_TILES) return fail(400, `Не більше ${LIVE_MAX_TILES} чанків за раз`);
    const cb = chunkBox(box);
    const ok = [];
    let o = 6;
    for (let i = 0; i < count; i++) {
      if (o + 28 > buf.byteLength) return fail(400, 'Обрізаний запит');
      const cx = dv.getInt32(o), cz = dv.getInt32(o + 4), hash = toHex(bytes.subarray(o + 8, o + 24)), n = dv.getUint32(o + 24);
      o += 28;
      if (n > BLOCKS_MAX_CHUNK || o + n > buf.byteLength) return fail(400, 'Завеликий чанк');
      if (n < 18 || bytes[o] !== 0x1f || bytes[o + 1] !== 0x8b) return fail(400, 'Блоки чанка мають бути стиснуті gzip');
      if (inBox(cb, cx, cz)) ok.push({ cx, cz, hash, data: buf.slice(o, o + n) });
      o += n;
    }
    const now = Date.now();
    let saved = 0;
    if (ok.length) {
      const res = await batchBlobs(env, (hex) => ok.map((t) => env.DB.prepare(
        `INSERT INTO live_blocks (layer, cx, cz, hash, data, updated_at) VALUES (?, ?, ?, ?, ${hex ? 'unhex(?)' : '?'}, ?)
         ON CONFLICT(layer, cx, cz) DO UPDATE SET hash = excluded.hash, data = excluded.data, updated_at = excluded.updated_at
         WHERE live_blocks.hash <> excluded.hash`
      ).bind(id, t.cx, t.cz, t.hash, hex ? toHexStr(t.data) : t.data, now)));
      saved = res.reduce((n, r) => n + (r.meta?.changes || 0), 0);
    }
    return json({ saved, unchanged: ok.length - saved, outside: count - ok.length });
  }

  if (method === 'POST' && !action) {
    if (!(await liveKeyOk(request, env))) return fail(401, 'Ключ мода не підходить');
    if (!layer.live) return fail(409, 'Для цього шару жива мапа вимкнена');
    if (Number(request.headers.get('content-length') || 0) > LIVE_MAX_BODY) return fail(413, 'Завеликий запит');
    const buf = await request.arrayBuffer();
    if (buf.byteLength > LIVE_MAX_BODY) return fail(413, 'Завеликий запит');
    let tiles;
    try { tiles = parseLiveTiles(buf); } catch (e) { return fail(400, e.message); }
    const [box] = liveLayers([layer]);
    const boxes = [box, ...box.areas].map(chunkBox);
    const ok = tiles.filter((t) => boxes.some((b) => inBox(b, t.cx, t.cz)));
    const player = str(request.headers.get('x-player'), 32).replace(/[^\w.-]/g, '');
    const now = Date.now();
    let saved = 0;
    if (ok.length) {
      const res = await batchBlobs(env, (hex) => ok.map((t) => env.DB.prepare(
        `INSERT INTO live_tiles (layer, cx, cz, hash, png, mini, player, updated_at) VALUES (?, ?, ?, ?, ${hex ? 'unhex(?), unhex(?)' : '?, ?'}, ?, ?)
         ON CONFLICT(layer, cx, cz) DO UPDATE SET hash = excluded.hash, png = excluded.png, mini = excluded.mini,
           player = excluded.player, updated_at = excluded.updated_at
         WHERE live_tiles.hash <> excluded.hash`
      ).bind(id, t.cx, t.cz, t.hash, hex ? toHexStr(t.png) : t.png, hex ? toHexStr(t.mini) : t.mini, player, now)));
      saved = res.reduce((n, r) => n + (r.meta?.changes || 0), 0);
    }
    return json({ saved, unchanged: ok.length - saved, outside: tiles.length - ok.length });
  }

  if (!authorized(request)) return fail(401, 'Потрібні права редактора');

  // Увімкнути живу мапу для шару й задати зріз за висотою.
  if (method === 'PATCH' && !action) {
    const body = await request.json().catch(() => ({}));
    let next = null;
    if (body.enabled) {
      const top = int(body.top), bottom = int(body.bottom);
      if (top === null || bottom === null) return fail(400, 'Вкажи зріз згори і знизу');
      if (top < bottom) return fail(400, 'Зріз згори має бути не нижче за зріз знизу');
      if (top > 2048 || bottom < -2048) return fail(400, 'Зріз за межами світу');
      const old = layer.live;
      const same = old && old.top === top && old.bottom === bottom;
      next = { top, bottom, epoch: same ? old.epoch || 0 : Date.now() };
      // Старі чанки намальовані з іншим зрізом: стираємо їх, мод перемалює.
      if (!same) await env.DB.prepare('DELETE FROM live_tiles WHERE layer = ?').bind(id).run();
    }
    await saveLayers(env, layers.map((l) => (l.id === id ? { ...l, live: next } : l)));
    return json({ ...layer, live: next });
  }

  // Області: додають територію, яку оновлює мод, і можуть мати свій зріз.
  if (action === 'areas') {
    const areas = layer.liveAreas || [];
    const old = a ? areas.find((x) => x.id === a) : null;
    if (a && !old) return fail(404, 'Область не знайдено');
    let area = null;
    if ((method === 'POST' && !a) || (method === 'PUT' && a)) {
      const r = readArea(await request.json().catch(() => ({})), old);
      if (r.error) return fail(400, r.error);
      area = r.area;
      if (!old && areas.length >= LIVE_MAX_AREAS) return fail(400, `Не більше ${LIVE_MAX_AREAS} областей на шарі`);
    } else if (!(method === 'DELETE' && a)) {
      return fail(405, 'Метод не підтримується');
    }
    const next = !old ? [...areas, area] : area ? areas.map((x) => (x.id === a ? area : x)) : areas.filter((x) => x.id !== a);
    if (area && areaChunks(next) > LIVE_AREA_CHUNKS) {
      return fail(400, `Області завеликі: разом до ${LIVE_AREA_CHUNKS} чанків на шарі, це приблизно 1000×1000 блоків`);
    }

    const geo = (x) => (x ? [x.minX, x.minZ, x.maxX, x.maxZ, x.top, x.bottom].join() : '');
    const stmts = [];
    if (geo(old) !== geo(area)) {
      // Там, де зріз міг змінитися, старі чанки стираємо: мод намалює їх заново.
      const self = old || area;
      const boxes = [old, area].filter(Boolean).map(chunkBox);
      const slices = new Set([old, area].filter(Boolean).map(sliceKey));
      if (boxes.some((b) => boxesOverlap(b, chunkBox(layerBox(layer))))) slices.add(layer.live ? sliceKey(layer.live) : 'off');
      for (const x of areas) {
        if (x.id !== self.id && boxes.some((b) => boxesOverlap(b, chunkBox(x)))) slices.add(sliceKey(x));
      }
      if (slices.size > 1) {
        stmts.push(env.DB.prepare(`DELETE FROM live_tiles WHERE layer = ? AND (${boxes.map(boxSql).join(' OR ')})`).bind(id));
      }
      // Чанки, що опинилися поза територією, мод більше не оновить: їх теж прибираємо.
      const keep = [layerBox(layer), ...next].map(chunkBox);
      stmts.push(env.DB.prepare(`DELETE FROM live_tiles WHERE layer = ? AND NOT (${keep.map(boxSql).join(' OR ')})`).bind(id));
    }
    const erased = stmts.length ? (await env.DB.batch(stmts)).reduce((n, r) => n + (r.meta?.changes || 0), 0) : 0;
    // Стерті чанки не видно в запитах «що змінилося відтоді», тож нова епоха каже сайту й моду перечитати все.
    const nextLive = layer.live && erased ? { ...layer.live, epoch: Date.now() } : layer.live;
    await saveLayers(env, layers.map((l) => (l.id === id ? { ...l, live: nextLive, liveAreas: next } : l)));
    return json({ areas: next, area, erased });
  }

  // Стерти всі чанки шару (наприклад, після зміни зрізу).
  if (method === 'DELETE' && !action) {
    await env.DB.prepare('DELETE FROM live_tiles WHERE layer = ?').bind(id).run();
    if (layer.live) {
      await saveLayers(env, layers.map((l) => (l.id === id ? { ...l, live: { ...l.live, epoch: Date.now() } } : l)));
    }
    return json({ ok: true });
  }
  return fail(405, 'Метод не підтримується');
}

// ---------- Лор міста ----------
// Розділи історії міста. Читати може кожен, писати — редактор. До розділу можна додати одну обкладинку:
// сайт сам стискає її перед завантаженням, у KV вона лежить під lore:<розділ>:<id обкладинки>.
async function lore(request, env, method, id, action) {
  if (!id && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM lore ORDER BY pos, id').all();
    return json(results);
  }
  const loreId = id === undefined ? null : int(id);
  if (id !== undefined && loreId === null) return fail(404, 'Розділ не знайдено');

  if (action === 'cover' && (method === 'GET' || method === 'HEAD')) {
    const row = await env.DB.prepare('SELECT cover FROM lore WHERE id = ?').bind(loreId).first();
    if (!row?.cover) return fail(404, 'Обкладинки немає');
    const { value, metadata } = await env.FILES.getWithMetadata(`lore:${loreId}:${row.cover}`, 'arrayBuffer');
    if (!value) return fail(404, 'Обкладинки немає');
    return imageResponse(value, metadata?.type, 'public, max-age=31536000, immutable'); // адреса має ?v=<id обкладинки>
  }
  if (!authorized(request)) return fail(401, 'Потрібні права редактора');

  const read = async (cur = {}) => {
    const body = await request.json().catch(() => null);
    if (!body) return 'Не вдалося прочитати розділ';
    const has = (k) => body[k] !== undefined;
    const r = {
      title: has('title') ? str(body.title, 120) : cur.title,
      era: has('era') ? str(body.era, 60) : cur.era ?? '',
      body: has('body') ? String(body.body ?? '').slice(0, 30000) : cur.body ?? '',
      pos: has('pos') ? int(body.pos) ?? 0 : cur.pos ?? 0,
    };
    if (!r.title) return 'Вкажи назву розділу';
    return r;
  };

  if (!id && method === 'POST') {
    const r = await read();
    if (typeof r === 'string') return fail(400, r);
    if (r.pos === 0) {
      const last = await env.DB.prepare('SELECT MAX(pos) AS p FROM lore').first();
      r.pos = (last?.p || 0) + 10;
    }
    const row = await env.DB.prepare(
      'INSERT INTO lore (title, era, body, pos, author) VALUES (?, ?, ?, ?, ?) RETURNING *'
    ).bind(r.title, r.era, r.body, r.pos, who(request).user?.username || '').first();
    return json(row, 201);
  }
  if (loreId === null) return fail(405, 'Метод не підтримується');
  const cur = await env.DB.prepare('SELECT * FROM lore WHERE id = ?').bind(loreId).first();
  if (!cur) return fail(404, 'Розділ не знайдено');

  if (action === 'cover') {
    if (method === 'PUT') {
      const form = await request.formData().catch(() => null);
      const file = form?.get('image');
      if (!file || typeof file === 'string' || !file.size) return fail(400, 'Не вибрано картинку');
      if (!IMAGE_TYPES.includes(file.type)) return fail(400, 'Потрібна картинка PNG, JPG або WebP');
      if (file.size > MARKER_IMAGE_MAX) return fail(400, 'Картинка більша за 3 МБ');
      const coverId = randomHex(6);
      await env.FILES.put(`lore:${loreId}:${coverId}`, await file.arrayBuffer(), { metadata: { type: file.type } });
      const row = await env.DB.prepare("UPDATE lore SET cover = ?, updated_at = datetime('now') WHERE id = ? RETURNING *")
        .bind(coverId, loreId).first();
      if (cur.cover) await env.FILES.delete(`lore:${loreId}:${cur.cover}`);
      return json(row);
    }
    if (method === 'DELETE') {
      if (cur.cover) await env.FILES.delete(`lore:${loreId}:${cur.cover}`);
      const row = await env.DB.prepare("UPDATE lore SET cover = NULL, updated_at = datetime('now') WHERE id = ? RETURNING *")
        .bind(loreId).first();
      return json(row);
    }
    return fail(405, 'Метод не підтримується');
  }
  if (method === 'PATCH') {
    const r = await read(cur);
    if (typeof r === 'string') return fail(400, r);
    const row = await env.DB.prepare(
      "UPDATE lore SET title = ?, era = ?, body = ?, pos = ?, updated_at = datetime('now') WHERE id = ? RETURNING *"
    ).bind(r.title, r.era, r.body, r.pos, loreId).first();
    return json(row);
  }
  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM lore WHERE id = ?').bind(loreId).run();
    if (cur.cover) await env.FILES.delete(`lore:${loreId}:${cur.cover}`);
    return json({ ok: true });
  }
  return fail(405, 'Метод не підтримується');
}

function imageResponse(value, type, cache) {
  return new Response(value, {
    headers: { 'content-type': type || 'image/webp', 'x-content-type-options': 'nosniff', 'cache-control': cache },
  });
}

// ---------- Жителі: профілі з лором і скіном ----------
// Профіль може бути прив’язаний до акаунта жителя (user_id): тоді житель сам його редагує.
// Редактор створює й правит будь-які профілі. Скін — або свій PNG 64×64 (64×32 для старих скінів),
// або береться в Mojang за ніком, якщо гравець має ліцензію. Свій PNG лежить у KV під skin:<профіль>:<id>.
const SKIN_MAX = 64 * 1024;
const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;
const SKIN_CACHE_S = 6 * 3600;

async function memberRows(env, where = '', ...args) {
  const { results } = await env.DB.prepare(
    `SELECT m.*, u.username AS account FROM members m LEFT JOIN users u ON u.id = m.user_id ${where}
     ORDER BY m.name COLLATE NOCASE`
  ).bind(...args).all();
  return results;
}
function canEditMember(request, row) {
  const w = who(request);
  return w.editor || (!!w.user && !w.admin && row.user_id === w.user.id);
}

async function members(request, env, method, id, action) {
  if (!id && method === 'GET') return json(await memberRows(env));
  const memberId = id === undefined ? null : int(id);
  if (id !== undefined && memberId === null) return fail(404, 'Жителя не знайдено');

  if (action === 'skin' && (method === 'GET' || method === 'HEAD')) {
    const row = await env.DB.prepare(
      'SELECT m.nick, m.skin, u.username AS account FROM members m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?'
    ).bind(memberId).first();
    if (!row) return fail(404, 'Жителя не знайдено');
    if (row.skin) {
      const value = await env.FILES.get(`skin:${memberId}:${row.skin}`, 'arrayBuffer');
      if (value) return imageResponse(value, 'image/png', 'public, max-age=31536000, immutable');
    }
    // Ніку не вказано — пробуємо логін на сайті: зазвичай це той самий нік, що й у грі.
    const png = await mojangSkin(env, row.nick || row.account);
    if (!png) return fail(404, 'Скіна немає');
    return imageResponse(png, 'image/png', `public, max-age=${SKIN_CACHE_S}`);
  }

  const w = who(request);
  if (!w.user) return fail(401, 'Увійди, щоб редагувати профілі');

  const read = async (cur = {}) => {
    const body = await request.json().catch(() => null);
    if (!body) return 'Не вдалося прочитати профіль';
    const has = (k) => body[k] !== undefined;
    const m = {
      name: has('name') ? str(body.name, 60) : cur.name,
      nick: has('nick') ? str(body.nick, 32) : cur.nick ?? '',
      title: has('title') ? str(body.title, 80) : cur.title ?? '',
      bio: has('bio') ? str(body.bio, 300) : cur.bio ?? '',
      story: has('story') ? String(body.story ?? '').slice(0, 20000) : cur.story ?? '',
      since: has('since') ? str(body.since, 40) : cur.since ?? '',
      home_marker: has('home_marker') ? (body.home_marker === null || body.home_marker === '' ? null : int(body.home_marker)) : cur.home_marker ?? null,
      user_id: cur.user_id ?? null,
    };
    if (!m.name) return 'Вкажи ім’я';
    // До якого акаунта прив’язати профіль, вирішує лише редактор.
    if (has('account') && w.editor) {
      const account = str(body.account, 64);
      if (!account) m.user_id = null;
      else {
        const u = await env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').bind(account).first();
        if (!u) return `Акаунта «${account}» немає`;
        m.user_id = u.id;
      }
    }
    if (m.user_id !== null && (m.user_id !== cur.user_id || !cur.id)) {
      const taken = await env.DB.prepare('SELECT id FROM members WHERE user_id = ?').bind(m.user_id).first();
      if (taken) return 'У цього акаунта вже є профіль';
    }
    return m;
  };
  const one = async (mid) => (await memberRows(env, 'WHERE m.id = ?', mid))[0];

  if (!id && method === 'POST') {
    // Житель може створити лише свій профіль, редактор — будь-який.
    const m = await read(w.editor ? {} : { user_id: w.admin ? null : w.user.id });
    if (typeof m === 'string') return fail(400, m);
    if (!w.editor && m.user_id === null) return fail(401, 'Потрібні права редактора');
    const row = await env.DB.prepare(
      `INSERT INTO members (name, nick, title, bio, story, since, user_id, home_marker)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(m.name, m.nick, m.title, m.bio, m.story, m.since, m.user_id, m.home_marker).first();
    return json(await one(row.id), 201);
  }
  if (memberId === null) return fail(405, 'Метод не підтримується');
  const cur = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(memberId).first();
  if (!cur) return fail(404, 'Жителя не знайдено');
  if (!canEditMember(request, cur)) return fail(401, 'Це не твій профіль');

  if (action === 'skin') {
    if (method === 'PUT') {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > SKIN_MAX) return fail(400, 'Файл скіна завеликий');
      const size = pngSize(new Uint8Array(buf));
      if (!size) return fail(400, 'Скін має бути PNG');
      if (size.w !== 64 || (size.h !== 64 && size.h !== 32)) return fail(400, 'Скін має бути 64×64 (або старий 64×32)');
      const skinId = randomHex(6);
      await env.FILES.put(`skin:${memberId}:${skinId}`, buf);
      await env.DB.prepare("UPDATE members SET skin = ?, updated_at = datetime('now') WHERE id = ?").bind(skinId, memberId).run();
      if (cur.skin) await env.FILES.delete(`skin:${memberId}:${cur.skin}`);
      return json(await one(memberId));
    }
    if (method === 'DELETE') {
      if (cur.skin) await env.FILES.delete(`skin:${memberId}:${cur.skin}`);
      await env.DB.prepare("UPDATE members SET skin = NULL, updated_at = datetime('now') WHERE id = ?").bind(memberId).run();
      return json(await one(memberId));
    }
    return fail(405, 'Метод не підтримується');
  }
  if (method === 'PATCH') {
    const m = await read(cur);
    if (typeof m === 'string') return fail(400, m);
    await env.DB.prepare(
      `UPDATE members SET name = ?, nick = ?, title = ?, bio = ?, story = ?, since = ?, user_id = ?, home_marker = ?,
       updated_at = datetime('now') WHERE id = ?`
    ).bind(m.name, m.nick, m.title, m.bio, m.story, m.since, m.user_id, m.home_marker, memberId).run();
    return json(await one(memberId));
  }
  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM members WHERE id = ?').bind(memberId).run();
    if (cur.skin) await env.FILES.delete(`skin:${memberId}:${cur.skin}`);
    return json({ ok: true });
  }
  return fail(405, 'Метод не підтримується');
}

// Розмір картинки з заголовка PNG (IHDR), без розпаковки.
function pngSize(b) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (b.length < 24 || sig.some((v, i) => b[i] !== v)) return null;
  const dv = new DataView(b.buffer, b.byteOffset);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

// Скін ліцензійного гравця за ніком. Спершу питаємо Mojang, а якщо Mojang не відповідає
// (ліміт запитів, блок спільних IP Cloudflare), то playerdb.co, який віддає те саме з кешу Mojang.
// Знайдений скін кешується в KV на 6 годин. «Такого ліцензійного ніка немає» — на годину,
// а мережеву помилку не кешуємо, щоб наступний перегляд спробував знову.
const MISS = Symbol('miss');
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'city-site' }, cf: { cacheTtl: 600 } });
  if (res.status === 404 || res.status === 204) return MISS;
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}
async function skinUrlFromMojang(nick) {
  let profile;
  try { profile = await getJson(`https://api.minecraftservices.com/minecraft/profile/lookup/name/${nick}`); }
  catch { profile = await getJson(`https://api.mojang.com/users/profiles/minecraft/${nick}`); }
  if (profile === MISS || !profile?.id) return MISS;
  const data = await getJson(`https://sessionserver.mojang.com/session/minecraft/profile/${profile.id}`);
  const prop = data !== MISS && data?.properties?.find((p) => p.name === 'textures');
  return (prop && JSON.parse(atob(prop.value))?.textures?.SKIN?.url) || MISS;
}
async function skinUrlFromPlayerDb(nick) {
  const data = await getJson(`https://playerdb.co/api/player/minecraft/${nick}`);
  if (data === MISS || data?.success === false) return MISS;
  const p = data?.data?.player;
  if (!p) throw new Error('playerdb: немає даних');
  const prop = p.properties?.find((x) => x.name === 'textures');
  const url = prop && JSON.parse(atob(prop.value))?.textures?.SKIN?.url;
  return url || p.skin_texture || MISS;
}
async function mojangSkin(env, nick) {
  if (!nick || !NICK_RE.test(nick)) return null;
  const key = `skinc:${nick.toLowerCase()}`;
  const cached = await env.FILES.get(key, 'arrayBuffer');
  if (cached) return cached.byteLength ? cached : null;
  let url = null, failed = 0;
  for (const source of [skinUrlFromMojang, skinUrlFromPlayerDb]) {
    try {
      const found = await source(nick);
      if (found === MISS) { url = MISS; break; } // джерело точно знає, що ліцензії з таким ніком немає
      url = found;
      break;
    } catch (e) { failed++; console.error('skin', nick, String(e)); }
  }
  if (url === null && failed) return null; // усі джерела впали: не кешуємо
  let png = null;
  if (url !== MISS && /^https?:\/\/textures\.minecraft\.net\//.test(url)) {
    const img = await fetch(url.replace(/^http:/, 'https:')).catch(() => null);
    if (!img?.ok) return null;
    const buf = await img.arrayBuffer();
    if (buf.byteLength <= SKIN_MAX && pngSize(new Uint8Array(buf))) png = buf;
  }
  await env.FILES.put(key, png || new ArrayBuffer(0), { expirationTtl: png ? SKIN_CACHE_S : 3600 });
  return png;
}

// ---------- Відвідуваність ----------
// Сторінка шле сюди відкриття сайту (entry) і кожного розділу. Запис не гальмує відповідь.
async function visit(request, env, waitUntil) {
  const body = await request.json().catch(() => ({}));
  const vid = String(body.vid || '');
  const section = VISIT_SECTIONS.includes(body.section) ? body.section : null;
  if (!/^[0-9a-f]{32}$/.test(vid) || !section || BOT_UA.test(request.headers.get('user-agent') || '')) {
    return json({ ok: false });
  }
  let ref = null;
  if (body.entry && body.ref) {
    try {
      const host = new URL(String(body.ref)).hostname.replace(/^www\./, '');
      if (host && host !== new URL(request.url).hostname) ref = host.slice(0, 80);
    } catch {}
  }
  const now = Date.now();
  const stmts = [
    env.DB.prepare('INSERT INTO visits (ts, vid, user, section, entry, ref) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(now, vid, who(request).user?.username || null, section, body.entry ? 1 : 0, ref),
  ];
  // Зрідка прибираємо зовсім старі записи, щоб база не росла без кінця.
  if (Math.random() < 0.01) {
    stmts.push(env.DB.prepare('DELETE FROM visits WHERE ts < ?').bind(now - VISITS_KEEP_DAYS * 86400_000));
  }
  const write = d1Retry(() => env.DB.batch(stmts)).catch((e) => console.error('visit', String(e)));
  if (waitUntil) waitUntil(write); else await write;
  return json({ ok: true });
}

// Статистика для редакторів. days — за скільки днів, tz — зсув часового поясу браузера в хвилинах
// (як Date.getTimezoneOffset з мінусом), щоб «сьогодні» й дні збігалися з годинником редактора.
async function stats(request, env) {
  if (!authorized(request)) return fail(403, 'Відвідуваність бачать лише редактори');
  const q = new URL(request.url).searchParams;
  const days = Math.min(Math.max(parseInt(q.get('days'), 10) || 30, 1), 365);
  const tz = Math.min(Math.max(parseInt(q.get('tz'), 10) || 0, -840), 840);
  const shift = tz * 60_000;
  const now = Date.now();
  // Початок сьогоднішнього дня за часом редактора, далі — days днів назад.
  const todayStart = Math.floor((now + shift) / 86400_000) * 86400_000 - shift;
  const from = todayStart - (days - 1) * 86400_000;
  const day = `date((ts + ${shift}) / 1000, 'unixepoch')`;
  const all = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results);
  const one = (sql, ...args) => env.DB.prepare(sql).bind(...args).first();
  const SUMMARY = `SELECT COUNT(DISTINCT vid) AS visitors, SUM(entry) AS visits, COUNT(*) AS views,
    COUNT(DISTINCT user) AS users FROM visits WHERE ts >= ?`;
  const [today, period, active, daily, sections, users, refs, total] = await d1Retry(() => Promise.all([
    one(SUMMARY, todayStart),
    one(SUMMARY, from),
    one('SELECT COUNT(DISTINCT vid) AS n FROM visits WHERE ts >= ?', now - 15 * 60_000),
    all(`SELECT ${day} AS day, COUNT(DISTINCT vid) AS visitors, SUM(entry) AS visits, COUNT(*) AS views
      FROM visits WHERE ts >= ? GROUP BY day ORDER BY day`, from),
    all(`SELECT section, COUNT(*) AS views, COUNT(DISTINCT vid) AS visitors
      FROM visits WHERE ts >= ? GROUP BY section ORDER BY views DESC`, from),
    all(`SELECT user, SUM(entry) AS visits, COUNT(*) AS views, COUNT(DISTINCT ${day}) AS days, MAX(ts) AS last
      FROM visits WHERE ts >= ? AND user IS NOT NULL GROUP BY user ORDER BY last DESC LIMIT 100`, from),
    all(`SELECT ref, COUNT(*) AS visits FROM visits WHERE ts >= ? AND entry = 1 AND ref IS NOT NULL
      GROUP BY ref ORDER BY visits DESC LIMIT 10`, from),
    one('SELECT COUNT(DISTINCT vid) AS visitors, MIN(ts) AS since FROM visits'),
  ]));
  // Дні без жодного відвідування теж показуємо, нулями.
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const series = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from + shift + i * 86400_000).toISOString().slice(0, 10);
    series.push(byDay.get(d) || { day: d, visitors: 0, visits: 0, views: 0 });
  }
  const num = (r) => ({ visitors: r?.visitors || 0, visits: r?.visits || 0, views: r?.views || 0, users: r?.users || 0 });
  return json({
    days, today: num(today), period: num(period), active: active?.n || 0,
    daily: series, sections, users, refs,
    total: { visitors: total?.visitors || 0, since: total?.since || null },
  });
}
