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
  LIVE_SCHEMA,
  'CREATE INDEX IF NOT EXISTS live_tiles_updated ON live_tiles (layer, updated_at)',
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
    if (section === 'auth' && method === 'POST') {
      return authorized(request, env) ? json({ ok: true }) : fail(401, 'Неправильний пароль');
    }
    if (section === 'schematics') return await schematics(request, env, method, id, action);
    if (section === 'tasks') return await tasks(request, env, method, id);
    if (section === 'map') return await map(request, env, method, id, action);
    if (section === 'markers') return await markers(request, env, method, id, action, parts[3]);
    if (section === 'live') return await live(request, env, method, parts, waitUntil);
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
  if (method === 'GET' && imageId) {
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
  if (!authorized(request, env)) return fail(401, 'Потрібен пароль редактора');
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
      live: existing?.live || null, // налаштування живої мапи не губляться, коли шар перемальовують
      liveAreas: existing?.liveAreas || [],
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
    await env.DB.prepare('DELETE FROM live_tiles WHERE layer = ?').bind(id).run();
    await saveLayers(env, layers.filter((l) => l.id !== id));
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
function liveLayers(layers) {
  return layers.filter((l) => l.live).map((l) => ({
    id: l.id, name: l.name, dimension: l.dimension, top: l.live.top, bottom: l.live.bottom, epoch: l.live.epoch || 0,
    ...layerBox(l),
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
  if (authorized(request, env)) return true;
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
    if (!authorized(request, env)) return fail(401, 'Потрібен пароль редактора');
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
    return new Response(JSON.stringify({
      live: layer.live || null,
      tiles: results.map((r) => [r.cx, r.cz, r.hash, r.updated_at, r.player]),
    }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }

  // Міні всіх чанків одним шматком: i32 cx, i32 cz і 1024 байти RGBA на кожен.
  if (method === 'GET' && action === 'minis') {
    const { results } = await env.DB.prepare('SELECT cx, cz, mini FROM live_tiles WHERE layer = ? AND updated_at >= ?')
      .bind(id, since).all();
    const size = 8 + MINI_BYTES;
    const out = new Uint8Array(results.length * size);
    const dv = new DataView(out.buffer);
    results.forEach((r, i) => {
      dv.setInt32(i * size, r.cx);
      dv.setInt32(i * size + 4, r.cz);
      out.set(new Uint8Array(r.mini).subarray(0, MINI_BYTES), i * size + 8);
    });
    return new Response(out, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
  }

  if (method === 'GET' && action === 'tile') {
    const cx = int(a), cz = int(b);
    if (cx === null || cz === null) return fail(404, 'Чанк не знайдено');
    const want = new URL(request.url).searchParams.get('h');
    const cache = want && typeof caches !== 'undefined' ? caches.default : null;
    const hit = cache && (await cache.match(request).catch(() => null));
    if (hit) return hit;
    const row = await env.DB.prepare('SELECT png, hash FROM live_tiles WHERE layer = ? AND cx = ? AND cz = ?')
      .bind(id, cx, cz).first();
    if (!row) return fail(404, 'Чанк не знайдено');
    const fresh = want === row.hash; // в адресі хеш, тож таку картинку можна кешувати назавжди
    const res = new Response(new Uint8Array(row.png), {
      headers: {
        'content-type': 'image/png',
        'cache-control': fresh ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
      },
    });
    if (fresh && cache && waitUntil) waitUntil(cache.put(request, res.clone()).catch(() => {}));
    return res;
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
      const res = await env.DB.batch(ok.map((t) => env.DB.prepare(
        `INSERT INTO live_tiles (layer, cx, cz, hash, png, mini, player, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(layer, cx, cz) DO UPDATE SET hash = excluded.hash, png = excluded.png, mini = excluded.mini,
           player = excluded.player, updated_at = excluded.updated_at
         WHERE live_tiles.hash <> excluded.hash`
      ).bind(id, t.cx, t.cz, t.hash, t.png, t.mini, player, now)));
      saved = res.reduce((n, r) => n + (r.meta?.changes || 0), 0);
    }
    return json({ saved, unchanged: ok.length - saved, outside: tiles.length - ok.length });
  }

  if (!authorized(request, env)) return fail(401, 'Потрібен пароль редактора');

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
