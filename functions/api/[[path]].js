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

function authorized(request, env) {
  const pass = env.EDIT_PASSWORD;
  if (!pass) return false;
  return request.headers.get('x-password') === pass;
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
function int(v) {
  const n = Number(v);
  return Number.isInteger(n) && Math.abs(n) <= 30_000_000 ? n : null;
}

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
    author TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
];
// Типи міток. Підписи й значки задає сайт (app.js), тут лише список дозволених.
const MARKER_KINDS = ['home', 'farm', 'storage', 'mine', 'portal', 'shop', 'danger', 'other'];

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
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

export async function onRequest({ request, env, params }) {
  const parts = params.path || [];
  const method = request.method;
  const [section, id, action] = parts;

  if (!env.DB || !env.FILES) {
    return fail(500, 'Сайт не налаштовано: у Cloudflare не прив’язані база DB і сховище FILES');
  }

  try {
    await ensureSchema(env);
    if (section === 'auth' && method === 'POST') {
      return authorized(request, env) ? json({ ok: true }) : fail(401, 'Неправильний пароль');
    }
    if (section === 'schematics') return await schematics(request, env, method, id, action);
    if (section === 'tasks') return await tasks(request, env, method, id);
    if (section === 'map') return await map(request, env, method, id, action);
    if (section === 'markers') return await markers(request, env, method, id);
    if (section === 'colors' && method === 'GET') return json(await getColors(env));
    return fail(404, 'Не знайдено');
  } catch (e) {
    console.error(e);
    return fail(500, 'Помилка сервера');
  }
}

async function schematics(request, env, method, id, action) {
  if (!id && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM schematics ORDER BY created_at DESC'
    ).all();
    return json(results);
  }

  if (!id && method === 'POST') {
    if (!authorized(request, env)) return fail(401, 'Потрібен пароль редактора');
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
        'cache-control': 'public, max-age=86400',
      },
    });
  }
  if (method === 'GET') return json(row);

  if (method === 'DELETE') {
    if (!authorized(request, env)) return fail(401, 'Потрібен пароль редактора');
    await env.FILES.delete(`schem:${id}`);
    await env.DB.prepare('DELETE FROM schematics WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  return fail(405, 'Метод не підтримується');
}

async function tasks(request, env, method, id) {
  if (!id && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM tasks ORDER BY id').all();
    return json(results);
  }
  if (!authorized(request, env)) return fail(401, 'Потрібен пароль редактора');

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
async function markers(request, env, method, id) {
  if (!id && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM markers ORDER BY name COLLATE NOCASE').all();
    return json(results);
  }
  if (!authorized(request, env)) return fail(401, 'Потрібен пароль редактора');

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
    return json(row, 201);
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
    return json(row);
  }
  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM markers WHERE id = ?').bind(markerId).run();
    return json({ ok: true });
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

  if (!authorized(request, env)) return fail(401, 'Потрібен пароль редактора');

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
    };
    if (hasFile) {
      await env.FILES.put(`map:${layer.id}`, await file.arrayBuffer(), { metadata: { type: file.type } });
    }
    if (hasModel) await env.FILES.put(`model:${layer.id}`, await model.arrayBuffer());
    else if (!modelInfo && existing?.model) await env.FILES.delete(`model:${layer.id}`);
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
    await saveLayers(env, layers.filter((l) => l.id !== id));
    return json({ ok: true });
  }
  return fail(405, 'Метод не підтримується');
}
