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
];

const MAP_TASK = `Город под землёй, поэтому обычная карта сверху (и BlueMap сервера) его не показывает. Нужна карта среза на высоте города. Способы от лучшего к простому:

СПОСОБ 1. Карта из схематика (лучший)
1. В Litematica выдели весь город: Area Selection, два угла по краям города, захвати все этажи по высоте.
2. Сохрани схематик (Save Schematic), файл появится в .minecraft/schematics.
3. Запиши Corner 1 и Corner 2 из Area Editor.
4. На сайте нажми «Войти», потом на вкладке «Карта» нажми «Карта из схематика».
5. Выбери файл и впиши меньшие X, Y и Z из двух углов.
6. Задай срез: «сверху» = чуть ниже потолка этажа, «снизу» = пол этажа. Превью покажет, что получится.
7. Сохрани слой. Для каждого этажа можно сделать отдельный слой («Этаж 1», «Этаж 2»).

СПОСОБ 2. Xaero's World Map (без схематика)
1. Поставь клиентский мод Xaero's World Map.
2. Открой карту (M), нажми иконку пещеры внизу слева. Cave Mode Type = Full, а Cave Mode Top Y поставь чуть ниже потолка города.
3. Пройди по всему городу, чтобы он прорисовался.
4. Выгрузи карту в PNG через экспорт в меню карты.
5. На сайте нажми «Загрузить картинку», впиши X и Z левого верхнего угла картинки и масштаб.

СПОСОБ 3. Через админа сервера
Попросить добавить в BlueMap отдельную карту с render-mask по высоте города (min-y / max-y) и выключенным remove-caves-below-y. Тогда подземный город появится на BlueMap и будет обновляться сам.

Файл картинки должен быть не больше 25 МБ.`;

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
        .bind('Загрузить карту города', MAP_TASK).run();
    }
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

export async function onRequest({ request, env, params }) {
  const parts = params.path || [];
  const method = request.method;
  const [section, id, action] = parts;

  if (!env.DB || !env.FILES) {
    return fail(500, 'Сайт не настроен: в Cloudflare не привязаны база DB и хранилище FILES');
  }

  try {
    await ensureSchema(env);
    if (section === 'auth' && method === 'POST') {
      return authorized(request, env) ? json({ ok: true }) : fail(401, 'Неверный пароль');
    }
    if (section === 'schematics') return await schematics(request, env, method, id, action);
    if (section === 'tasks') return await tasks(request, env, method, id);
    if (section === 'map') return await map(request, env, method, id, action);
    return fail(404, 'Не найдено');
  } catch (e) {
    console.error(e);
    return fail(500, 'Ошибка сервера');
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
    if (!authorized(request, env)) return fail(401, 'Нужен пароль редактора');
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return fail(400, 'Не выбран файл');
    if (file.size > MAX_FILE) return fail(400, 'Файл больше 25 МБ');
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!SCHEM_EXT.includes(ext)) return fail(400, 'Поддерживаются .schem, .litematic, .schematic, .nbt');

    const name = str(form.get('name'), 120);
    const x = int(form.get('x')), y = int(form.get('y')), z = int(form.get('z'));
    if (!name) return fail(400, 'Укажи название');
    if (x === null || y === null || z === null) return fail(400, 'Координаты должны быть целыми числами');
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

  if (!id) return fail(405, 'Метод не поддерживается');
  const row = await env.DB.prepare('SELECT * FROM schematics WHERE id = ?').bind(id).first();
  if (!row) return fail(404, 'Схематик не найден');

  if (method === 'GET' && action === 'file') {
    const data = await env.FILES.get(`schem:${id}`, 'arrayBuffer');
    if (!data) return fail(404, 'Файл не найден');
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
    if (!authorized(request, env)) return fail(401, 'Нужен пароль редактора');
    await env.FILES.delete(`schem:${id}`);
    await env.DB.prepare('DELETE FROM schematics WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  return fail(405, 'Метод не поддерживается');
}

async function tasks(request, env, method, id) {
  if (!id && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM tasks ORDER BY id').all();
    return json(results);
  }
  if (!authorized(request, env)) return fail(401, 'Нужен пароль редактора');

  if (!id && method === 'POST') {
    const body = await request.json();
    const title = str(body.title, 200);
    if (!title) return fail(400, 'Укажи название задачи');
    const status = STATUSES.includes(body.status) ? body.status : 'todo';
    const res = await env.DB.prepare(
      'INSERT INTO tasks (title, description, status, assignee) VALUES (?, ?, ?, ?) RETURNING *'
    ).bind(title, str(body.description, 5000), status, str(body.assignee, 60)).first();
    return json(res, 201);
  }

  const taskId = int(id);
  if (taskId === null) return fail(400, 'Неверный id');

  if (method === 'PATCH') {
    const body = await request.json();
    const cur = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
    if (!cur) return fail(404, 'Задача не найдена');
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
  return fail(405, 'Метод не поддерживается');
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

async function map(request, env, method, id, action) {
  if (method === 'GET' && !id) return json(await getLayers(env));

  if (method === 'GET' && action === 'model') {
    const data = await env.FILES.get(`model:${id}`, 'arrayBuffer');
    if (!data) return fail(404, 'У этого слоя нет 3D-модели');
    return new Response(data, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' },
    });
  }

  if (method === 'GET' && action === 'image') {
    const { value, metadata } = await env.FILES.getWithMetadata(`map:${id}`, 'arrayBuffer');
    if (!value) return fail(404, 'Картинка слоя не найдена');
    return new Response(value, {
      headers: {
        'content-type': metadata?.type || 'image/png',
        'cache-control': 'public, max-age=31536000, immutable', // в адресе есть версия
      },
    });
  }

  if (!authorized(request, env)) return fail(401, 'Нужен пароль редактора');

  if (method === 'POST' && !id) {
    const form = await request.formData();
    const layers = await getLayers(env);
    const replaceId = str(form.get('layerId'), 64);
    const existing = replaceId ? layers.find((l) => l.id === replaceId) : null;
    if (replaceId && !existing) return fail(404, 'Слой не найден');

    const name = str(form.get('name'), 60) || existing?.name;
    if (!name) return fail(400, 'Укажи название слоя');
    const dimension = DIMENSIONS.includes(form.get('dimension')) ? form.get('dimension') : 'overworld';
    const originX = int(form.get('originX')), originZ = int(form.get('originZ'));
    const scale = Number(form.get('scale'));
    if (originX === null || originZ === null) return fail(400, 'Укажи X и Z левого верхнего угла');
    if (!(scale >= 0.1 && scale <= 64)) return fail(400, 'Масштаб от 0.1 до 64 блоков на пиксель');

    const file = form.get('image');
    const hasFile = file && typeof file !== 'string' && file.size > 0;
    if (!hasFile && !existing) return fail(400, 'Не выбрана картинка');
    let { width, height } = existing || {};
    if (hasFile) {
      if (file.size > MAX_FILE) return fail(400, 'Картинка больше 25 МБ, сохрани её в JPG или WebP');
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return fail(400, 'Нужен PNG, JPG или WebP');
      width = int(form.get('width'));
      height = int(form.get('height'));
      if (!width || !height) return fail(400, 'Не удалось прочитать размер картинки');
    }

    // 3D-модель: схематик, из которого нарисована картинка. Хранится рядом со слоем.
    const model = form.get('model');
    const hasModel = model && typeof model !== 'string' && model.size > 0;
    let modelInfo = existing?.model || null;
    if (hasModel) {
      if (model.size > MAX_FILE) return fail(400, 'Схематик для 3D больше 25 МБ');
      const ext = (model.name.split('.').pop() || '').toLowerCase();
      if (!['schem', 'litematic'].includes(ext)) return fail(400, 'Для 3D нужен .schem или .litematic');
      const minY = int(form.get('modelMinY'));
      if (minY === null) return fail(400, 'Укажи нижнюю высоту схематика');
      modelInfo = { fileName: str(model.name, 200), format: ext, minY, version: Date.now() };
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
    return json(layer, existing ? 200 : 201);
  }

  if (method === 'DELETE' && id) {
    const layers = await getLayers(env);
    if (!layers.some((l) => l.id === id)) return fail(404, 'Слой не найден');
    await env.FILES.delete(`map:${id}`);
    await env.FILES.delete(`model:${id}`);
    await saveLayers(env, layers.filter((l) => l.id !== id));
    return json({ ok: true });
  }
  return fail(405, 'Метод не поддерживается');
}
