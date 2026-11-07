import { parseSchematic, renderTopDown, naturalShare } from './schem.js';
import { CONFIG } from './config.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const DIM_NAMES = { overworld: 'Верхний мир', nether: 'Незер', end: 'Энд' };
const state = {
  password: store.get('editPassword') || '',
  schematics: [], tasks: [], layers: [],
  dim: 'overworld',
  layerId: store.get('layerId'), // null = первый слой измерения, '' = только сетка
};

document.title = CONFIG.cityName;
$('#brandName').textContent = CONFIG.cityName;

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.password) headers['x-password'] = state.password;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
  }
  const res = await fetch('/api/' + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.password) setEditor(false);
    throw new Error(data.error || 'Ошибка ' + res.status);
  }
  return data;
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

const isEditor = () => document.body.classList.contains('editor');

// ---------- Вход ----------
function setEditor(on) {
  document.body.classList.toggle('editor', on);
  $('#loginBtn').textContent = on ? 'Выйти' : 'Войти';
  if (!on) { state.password = ''; store.set('editPassword', null); }
}

$('#loginBtn').addEventListener('click', () => {
  if (isEditor()) return setEditor(false);
  openDialog('#loginDialog');
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  state.password = form.password.value;
  try {
    await api('auth', { method: 'POST' });
    store.set('editPassword', state.password);
    setEditor(true);
    form.closest('dialog').close();
    form.reset();
    toast('Ты вошёл как редактор');
  } catch (err) {
    state.password = '';
    showError(form, err.message);
  }
});

// ---------- Диалоги ----------
function openDialog(sel) {
  const d = $(sel);
  showError($('form', d), '');
  d.showModal();
  return d;
}
function showError(form, msg) { $('[data-error]', form).textContent = msg; }
$$('dialog [data-cancel]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

async function withBusy(form, fn) {
  const btn = $('button.primary', form);
  btn.disabled = true;
  showError(form, '');
  try { await fn(); } catch (err) { showError(form, err.message); }
  finally { btn.disabled = false; }
}

// ---------- Вкладки ----------
function showView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'map') setTimeout(() => map.invalidateSize(), 0);
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

// ---------- BlueMap ----------
function bluemapLink(dim, x, y, z, distance) {
  const { url, maps } = CONFIG.bluemap || {};
  const id = maps?.[dim];
  if (!url || !id) return null;
  return `${url.replace(/\/$/, '')}/#${id}:${Math.round(x)}:${Math.round(y)}:${Math.round(z)}:${distance}:0:0.6:0:0:perspective`;
}

// ---------- Карта ----------
// В Minecraft X растёт на восток, Z на юг. В Leaflet: lat = -Z, lng = X.
const toLatLng = (x, z) => L.latLng(-z, x);
const map = L.map('map', {
  crs: L.CRS.Simple, minZoom: -5, maxZoom: 5, zoomSnap: 0.5, attributionControl: false,
}).setView([0, 0], -1);

// Сетка координат, подписи кратны 16 (границам чанков).
const GridLayer = L.GridLayer.extend({
  createTile(coords) {
    const tile = document.createElement('canvas');
    const size = this.getTileSize();
    tile.width = size.x; tile.height = size.y;
    const ctx = tile.getContext('2d');
    const scale = 2 ** coords.z; // пикселей на блок
    const x0 = (coords.x * size.x) / scale, z0 = (coords.y * size.y) / scale;
    let step = 16;
    while (step * scale < 48) step *= 2;
    ctx.strokeStyle = 'rgba(34,225,227,.08)';
    ctx.fillStyle = 'rgba(120,225,228,.4)';
    ctx.font = '10px JetBrains Mono, monospace';
    const startX = Math.ceil(x0 / step) * step, startZ = Math.ceil(z0 / step) * step;
    for (let x = startX; x < x0 + size.x / scale; x += step) {
      const px = (x - x0) * scale;
      ctx.beginPath(); ctx.moveTo(px + .5, 0); ctx.lineTo(px + .5, size.y); ctx.stroke();
      ctx.fillText(x, px + 3, 11);
    }
    for (let z = startZ; z < z0 + size.y / scale; z += step) {
      const pz = (z - z0) * scale;
      ctx.beginPath(); ctx.moveTo(0, pz + .5); ctx.lineTo(size.x, pz + .5); ctx.stroke();
      ctx.fillText(z, 3, pz - 3);
    }
    return tile;
  },
});
const grid = new GridLayer({ pane: 'overlayPane' }).addTo(map);
let cityImage = null;
const markers = L.layerGroup().addTo(map);

const layersInDim = () => state.layers.filter((l) => l.dimension === state.dim);
function currentLayer() {
  const list = layersInDim();
  if (state.layerId === '') return null;
  return list.find((l) => l.id === state.layerId) || list[0] || null;
}
const layerBounds = (l) => L.latLngBounds(
  toLatLng(l.originX, l.originZ),
  toLatLng(l.originX + l.width * l.scale, l.originZ + l.height * l.scale)
);

function renderLayerSelect() {
  const sel = $('#layerSelect');
  const list = layersInDim();
  sel.hidden = !list.length;
  const cur = currentLayer();
  sel.innerHTML = list.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')
    + '<option value="">Только сетка</option>';
  sel.value = cur ? cur.id : '';
}

function renderCityMap() {
  if (cityImage) { cityImage.remove(); cityImage = null; }
  renderLayerSelect();
  syncMode();
  $('#mapEmpty').hidden = state.layers.length > 0 || state.dim !== 'overworld';
  const layer = currentLayer();
  if (!layer) return;
  cityImage = L.imageOverlay(`/api/map/${encodeURIComponent(layer.id)}/image?v=${layer.version}`, layerBounds(layer))
    .addTo(map);
  grid.bringToFront();
}

function renderMarkers() {
  markers.clearLayers();
  for (const s of state.schematics) {
    if (s.dimension !== state.dim) continue;
    const icon = L.divIcon({ className: '', html: '<div class="schem-pin"></div>', iconSize: [18, 18] });
    L.marker(toLatLng(s.x + 0.5, s.z + 0.5), { icon, title: s.name })
      .bindTooltip(`${esc(s.name)} <span class="mono">Y ${s.y}</span>`, { className: 'schem-label', direction: 'top', offset: [0, -10] })
      .on('click', () => openSchematic(s.id))
      .addTo(markers);
  }
}

function updateBluemapButton() {
  const c = map.getCenter();
  const link = bluemapLink(state.dim, c.lng, 70, -c.lat, 400);
  const btn = $('#bluemapBtn');
  btn.hidden = !link;
  if (link) btn.href = link;
}
map.on('moveend', updateBluemapButton);

map.on('mousemove', (e) => {
  $('#cursorCoords').textContent = `X ${Math.floor(e.latlng.lng)} · Z ${Math.floor(-e.latlng.lat)}`;
});
map.on('contextmenu', (e) => {
  const x = Math.floor(e.latlng.lng), z = Math.floor(-e.latlng.lat);
  if (isEditor()) openSchemDialog({ x, z });
  else L.popup().setLatLng(e.latlng).setContent(`<span class="mono">X ${x} · Z ${z}</span>`).openOn(map);
});

function setDimension(dim) {
  state.dim = dim;
  $('#dimSelect').value = dim;
  renderCityMap();
  renderMarkers();
  updateBluemapButton();
}
$('#dimSelect').addEventListener('change', (e) => setDimension(e.target.value));
$('#layerSelect').addEventListener('change', (e) => {
  state.layerId = e.target.value;
  store.set('layerId', state.layerId);
  renderCityMap();
  if (v3d.mode === '3d') show3d();
});

// ---------- 3D-режим ----------
// Слой, нарисованный из схематика, хранит сам схематик, и город можно покрутить в 3D.
const v3d = { mode: '2d', viewer: null, key: null, schem: null, layer: null };
function syncMode() {
  const layer = currentLayer();
  $('#modeSeg').hidden = !layer?.model;
  if (!layer?.model && v3d.mode === '3d') setMode('2d');
}
function setMode(mode) {
  v3d.mode = mode;
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#view3d').hidden = mode !== '3d';
  $('#view-map').classList.toggle('mode-3d', mode === '3d');
  store.set('mapMode', mode);
  if (mode === '3d') show3d();
}
$$('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function v3dStatus(text) {
  const el = $('#v3dStatus');
  el.hidden = !text;
  el.textContent = text || '';
}

async function show3d() {
  const layer = currentLayer();
  if (!layer?.model) return setMode('2d');
  const key = `${layer.id}:${layer.model.version}`;
  try {
    if (v3d.key !== key) {
      v3dStatus('Загружаю 3D-модель города…');
      const [{ createViewer }, buf] = await Promise.all([
        import('./voxel.js'),
        fetch(`/api/map/${encodeURIComponent(layer.id)}/model?v=${layer.model.version}`).then((r) => {
          if (!r.ok) throw new Error('модель не найдена');
          return r.arrayBuffer();
        }),
      ]);
      v3dStatus('Строю город из блоков…');
      await new Promise((r) => setTimeout(r, 30));
      const schem = await parseSchematic(buf, layer.model.fileName);
      v3d.viewer ??= createViewer($('#v3dCanvas'));
      v3d.schem = schem;
      v3d.layer = layer;
      v3d.key = key;
      $('#v3dRock').checked = naturalShare(schem) > 0.4;
      const clip = $('#v3dClip');
      clip.min = layer.model.minY;
      clip.max = layer.model.minY + schem.height - 1;
      clip.value = clip.max;
      build3d(false);
    }
    v3d.layer = layer;
    markers3d();
    v3dStatus('');
  } catch (err) {
    console.error(err);
    v3dStatus('Не удалось открыть 3D: ' + err.message);
  }
}

function build3d(keepView) {
  v3d.viewer.setModel(v3d.schem, { hideNatural: $('#v3dRock').checked, keepView });
  applyClip();
}
function applyClip() {
  const clip = $('#v3dClip');
  const y = Number(clip.value);
  $('#v3dClipVal').textContent = y >= Number(clip.max) ? 'весь город' : 'Y ' + y;
  if (v3d.viewer && v3d.layer?.model) v3d.viewer.setClip(y - v3d.layer.model.minY + 1);
}
$('#v3dClip').addEventListener('input', applyClip);
$('#v3dRock').addEventListener('change', () => {
  if (!v3d.schem) return;
  v3dStatus('Перестраиваю…');
  setTimeout(() => { build3d(true); v3dStatus(''); }, 30);
});

function markers3d() {
  const layer = v3d.layer;
  if (!v3d.viewer || !layer?.model || !v3d.schem) return;
  const { width: W, height: H, length: L } = v3d.schem;
  const list = state.schematics
    .filter((s) => s.dimension === layer.dimension)
    .map((s) => ({ id: s.id, label: s.name, x: s.x - layer.originX, y: s.y - layer.model.minY, z: s.z - layer.originZ }))
    .filter((m) => m.x > -16 && m.z > -16 && m.x < W + 16 && m.z < L + 16 && m.y > -16 && m.y < H + 16);
  v3d.viewer.setMarkers(list, openSchematic);
}

function fitCity() {
  const layer = currentLayer();
  if (layer) map.fitBounds(layerBounds(layer));
  else {
    const pts = state.schematics.filter((s) => s.dimension === state.dim);
    if (pts.length) map.fitBounds(L.latLngBounds(pts.map((s) => toLatLng(s.x, s.z))).pad(0.3), { maxZoom: 1 });
  }
}

async function loadLayers() {
  state.layers = await api('map');
}

// После сохранения слоя показываем именно его.
async function showSavedLayer(layer) {
  await loadLayers();
  state.layerId = layer.id;
  store.set('layerId', layer.id);
  setDimension(layer.dimension);
  showView('map');
  map.fitBounds(layerBounds(layer));
}

function fillLayerSelect(select, { allowNew = true } = {}) {
  select.innerHTML = (allowNew ? '<option value="">Новый слой</option>' : '')
    + state.layers.map((l) => `<option value="${esc(l.id)}">${esc(l.name)} · ${DIM_NAMES[l.dimension]}</option>`).join('');
}

// --- Слой из картинки ---
$('#uploadMapBtn').addEventListener('click', () => {
  const f = $('#mapForm');
  f.reset();
  fillLayerSelect(f.layerId);
  const cur = currentLayer();
  f.layerId.value = cur ? cur.id : '';
  syncMapForm();
  openDialog('#mapDialog');
});
function syncMapForm() {
  const f = $('#mapForm');
  const layer = state.layers.find((l) => l.id === f.layerId.value);
  $('[data-delete]', f).hidden = !layer;
  $('[data-keep]', f).hidden = !layer;
  f.image.required = !layer;
  if (layer) {
    f.name.value = layer.name; f.dimension.value = layer.dimension;
    f.originX.value = layer.originX; f.originZ.value = layer.originZ; f.scale.value = layer.scale;
  } else {
    f.name.value = ''; f.dimension.value = state.dim; f.scale.value = 1;
  }
}
$('#mapForm').layerId.addEventListener('change', syncMapForm);
$('#mapForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  withBusy(form, async () => {
    const fd = new FormData(form);
    const file = form.image.files[0];
    if (file) {
      const bmp = await createImageBitmap(file);
      fd.set('width', bmp.width);
      fd.set('height', bmp.height);
      bmp.close();
    } else {
      fd.delete('image');
    }
    const layer = await api('map', { method: 'POST', body: fd });
    form.closest('dialog').close();
    await showSavedLayer(layer);
    toast(`Слой «${layer.name}» сохранён`);
  });
});
$('#mapForm [data-delete]').addEventListener('click', async () => {
  const form = $('#mapForm');
  const layer = state.layers.find((l) => l.id === form.layerId.value);
  if (!layer || !confirm(`Удалить слой «${layer.name}»?`)) return;
  try {
    await api('map/' + encodeURIComponent(layer.id), { method: 'DELETE' });
    form.closest('dialog').close();
    await loadLayers();
    renderCityMap();
    toast('Слой удалён');
  } catch (err) { showError(form, err.message); }
});

// --- Слой из схематика всего города ---
const fromSchem = { schem: null, file: null, timer: 0 };
$('#fromSchemBtn').addEventListener('click', () => {
  const f = $('#fromSchemForm');
  f.reset();
  fromSchem.schem = null;
  $('fieldset', f).disabled = true;
  $('[data-info]', f).textContent = 'Большой город может читаться несколько секунд.';
  $('[data-preview]', f).innerHTML = '<span class="muted">Здесь появится карта</span>';
  fillLayerSelect(f.layerId);
  const underground = state.layers.find((l) => /подзем/i.test(l.name));
  if (underground) { f.layerId.value = underground.id; f.name.value = underground.name; }
  f.dimension.value = state.dim;
  openDialog('#fromSchemDialog');
});

$('#fromSchemForm').file.addEventListener('change', async (e) => {
  const f = e.target.form;
  const file = e.target.files[0];
  const info = $('[data-info]', f);
  fromSchem.schem = null;
  $('fieldset', f).disabled = true;
  if (!file) return;
  info.textContent = 'Читаю схематик…';
  showError(f, '');
  try {
    await new Promise((r) => setTimeout(r, 30)); // дать браузеру обновить текст
    const schem = await parseSchematic(await file.arrayBuffer(), file.name);
    fromSchem.schem = schem;
    fromSchem.file = file;
    info.textContent = `${schem.width}×${schem.height}×${schem.length} блоков (ширина × высота × длина).`;
    const minY = Number(f.minY.value) || 0;
    f.topY.value = minY + schem.height - 1;
    f.bottomY.value = minY;
    $('fieldset', f).disabled = false;
    drawFromSchemPreview();
  } catch (err) {
    console.error(err);
    info.textContent = '';
    showError(f, 'Не удалось прочитать схематик: ' + err.message);
  }
});

function fromSchemCanvas() {
  const f = $('#fromSchemForm');
  const minY = Number(f.minY.value) || 0;
  return renderTopDown(fromSchem.schem, {
    topY: Number(f.topY.value) - minY,
    bottomY: Number(f.bottomY.value) - minY,
  });
}
function drawFromSchemPreview() {
  if (!fromSchem.schem) return;
  const box = $('#fromSchemForm [data-preview]');
  box.innerHTML = '';
  box.appendChild(fromSchemCanvas());
}
for (const name of ['minY', 'topY', 'bottomY']) {
  $('#fromSchemForm')[name].addEventListener('input', () => {
    clearTimeout(fromSchem.timer);
    fromSchem.timer = setTimeout(drawFromSchemPreview, 250);
  });
}
$('#fromSchemForm').layerId.addEventListener('change', (e) => {
  const layer = state.layers.find((l) => l.id === e.target.value);
  if (layer) { e.target.form.name.value = layer.name; e.target.form.dimension.value = layer.dimension; }
});

$('#fromSchemForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  withBusy(form, async () => {
    if (!fromSchem.schem) throw new Error('Сначала выбери схематик');
    if (Number(form.topY.value) < Number(form.bottomY.value)) throw new Error('Верх среза должен быть выше низа');
    const canvas = fromSchemCanvas();
    let blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    let type = 'image/png';
    if (blob.size > 24 * 1024 * 1024) {
      blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.95));
      type = 'image/webp';
    }
    const fd = new FormData();
    fd.set('image', new File([blob], type === 'image/png' ? 'map.png' : 'map.webp', { type }));
    fd.set('layerId', form.layerId.value);
    fd.set('name', form.name.value || 'Подземный город');
    fd.set('dimension', form.dimension.value);
    fd.set('originX', form.minX.value);
    fd.set('originZ', form.minZ.value);
    fd.set('scale', 1);
    fd.set('width', canvas.width);
    fd.set('height', canvas.height);
    fd.set('model', fromSchem.file);
    fd.set('modelMinY', form.minY.value);
    const layer = await api('map', { method: 'POST', body: fd });
    form.closest('dialog').close();
    await showSavedLayer(layer);
    toast(`Слой «${layer.name}» сохранён`);
  });
});

// ---------- Схематики ----------
function fmtSize(b) {
  return b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ';
}
const dims = (s) => (s.width ? `${s.width}×${s.height}×${s.length}` : '');

function renderSchemList() {
  const q = $('#schemSearch').value.trim().toLowerCase();
  const list = state.schematics.filter((s) =>
    !q || s.name.toLowerCase().includes(q) || (s.author || '').toLowerCase().includes(q));
  $('#schemList').innerHTML = list.length ? list.map((s) => `
    <article class="schem-card" data-id="${esc(s.id)}" tabindex="0">
      <h3>${esc(s.name)}</h3>
      <div class="meta mono"><span>${s.x} ${s.y} ${s.z}</span>${dims(s) ? `<span>${dims(s)}</span>` : ''}</div>
      <div class="meta">
        <span class="tag">.${esc(s.format)}</span>
        <span class="tag">${DIM_NAMES[s.dimension] || esc(s.dimension)}</span>
        ${s.author ? `<span>${esc(s.author)}</span>` : ''}
      </div>
    </article>`).join('')
    : `<p class="empty">${q ? 'Ничего не нашлось' : 'Схематиков пока нет. Войди как редактор и загрузи первый.'}</p>`;
}
$('#schemSearch').addEventListener('input', renderSchemList);
$('#schemList').addEventListener('click', (e) => {
  const card = e.target.closest('.schem-card');
  if (card) openSchematic(card.dataset.id);
});
$('#schemList').addEventListener('keydown', (e) => {
  const card = e.target.closest('.schem-card');
  if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSchematic(card.dataset.id); }
});

let preview = null;
function closeDrawer() {
  preview?.dispose();
  preview = null;
  $('#schemDrawer').hidden = true;
  if (location.hash.startsWith('#s=')) history.replaceState(null, '', location.pathname);
}
$('#schemDrawer [data-close]').addEventListener('click', closeDrawer);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('dialog[open]')) closeDrawer(); });

async function openSchematic(id) {
  const s = state.schematics.find((x) => x.id === id);
  if (!s) return;
  preview?.dispose();
  preview = null;
  history.replaceState(null, '', '#s=' + id);
  const tp = `/tp @s ${s.x} ${s.y} ${s.z}`;
  const blue = bluemapLink(s.dimension, s.x, s.y, s.z, 60);
  $('#drawerBody').innerHTML = `
    <h2>${esc(s.name)}</h2>
    <div class="meta muted">${s.author ? 'Автор: ' + esc(s.author) + ' · ' : ''}${new Date(s.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('ru')}</div>
    <div class="preview" id="previewBox"><div class="status">Загружаю превью…</div></div>
    <dl>
      <dt>Координаты</dt><dd class="mono">X ${s.x} · Y ${s.y} · Z ${s.z}</dd>
      <dt>Измерение</dt><dd>${DIM_NAMES[s.dimension] || esc(s.dimension)}</dd>
      ${dims(s) ? `<dt>Размер</dt><dd class="mono">${dims(s)} блоков</dd>` : ''}
      <dt>Файл</dt><dd>${esc(s.file_name)} · ${fmtSize(s.file_size)}</dd>
    </dl>
    ${s.description ? `<p class="desc">${esc(s.description)}</p>` : ''}
    <div class="actions">
      <a class="btn primary" href="/api/schematics/${esc(s.id)}/file" download>Скачать</a>
      <button class="btn" data-act="tp">Скопировать /tp</button>
      <button class="btn" data-act="show">На карте</button>
      ${blue ? `<a class="btn" href="${esc(blue)}" target="_blank" rel="noopener">BlueMap</a>` : ''}
      <button class="btn danger editor-only" data-act="delete">Удалить</button>
    </div>`;
  $('#schemDrawer').hidden = false;

  const body = $('#drawerBody');
  $('[data-act=tp]', body).onclick = async () => {
    try { await navigator.clipboard.writeText(tp); toast('Скопировано: ' + tp); }
    catch { toast(tp); }
  };
  $('[data-act=show]', body).onclick = () => {
    showView('map');
    if (state.dim !== s.dimension) setDimension(s.dimension);
    map.setView(toLatLng(s.x, s.z), 2);
  };
  $('[data-act=delete]', body).onclick = async () => {
    if (!confirm(`Удалить «${s.name}»? Файл удалится навсегда.`)) return;
    try {
      await api('schematics/' + s.id, { method: 'DELETE' });
      state.schematics = state.schematics.filter((x) => x.id !== s.id);
      closeDrawer(); renderSchemList(); renderMarkers();
      toast('Схематик удалён');
    } catch (err) { toast(err.message); }
  };

  const box = $('#previewBox');
  if (!['schem', 'litematic'].includes(s.format)) {
    $('.status', box).textContent = 'Превью есть только для .schem и .litematic, но файл можно скачать.';
    return;
  }
  try {
    const [buf, { createViewer }] = await Promise.all([
      fetch(`/api/schematics/${s.id}/file?preview`).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }),
      import('./voxel.js'),
    ]);
    const parsed = await parseSchematic(buf, s.file_name);
    if (!box.isConnected) return;
    // У подземных построек вокруг сплошная порода: по умолчанию её прячем.
    const toggle = document.createElement('label');
    toggle.className = 'check';
    toggle.innerHTML = '<input type="checkbox"> Скрыть породу и руды';
    const cb = $('input', toggle);
    cb.checked = naturalShare(parsed) > 0.4;
    box.after(toggle);
    box.innerHTML = '';
    preview = createViewer(box, { fog: false });
    const draw = () => preview.setModel(parsed, { hideNatural: cb.checked, keepView: true });
    cb.addEventListener('change', draw);
    draw();
  } catch (err) {
    console.error(err);
    if (box.isConnected) box.innerHTML = '<div class="status">Не удалось построить превью, но файл можно скачать.</div>';
  }
}

function openSchemDialog(prefill = {}) {
  const f = $('#schemForm');
  f.reset();
  $('#schemFileInfo').textContent = '.schem, .litematic, .schematic или .nbt, до 25 МБ';
  if (prefill.x !== undefined) { f.x.value = prefill.x; f.z.value = prefill.z; }
  f.dimension.value = state.dim;
  f.author.value = store.get('author') || '';
  delete f.dataset.dims;
  openDialog('#schemDialog');
}
$('#addSchemBtn').addEventListener('click', () => openSchemDialog());
$('#addSchemBtn2').addEventListener('click', () => openSchemDialog());

$('#schemForm').file.addEventListener('change', async (e) => {
  const f = e.target.form;
  const file = e.target.files[0];
  delete f.dataset.dims;
  if (!file) return;
  if (!f.name.value) f.name.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  const info = $('#schemFileInfo');
  info.textContent = fmtSize(file.size);
  try {
    const p = await parseSchematic(await file.arrayBuffer(), file.name);
    f.dataset.dims = JSON.stringify([p.width, p.height, p.length]);
    info.textContent = `${fmtSize(file.size)} · ${p.width}×${p.height}×${p.length} блоков`;
  } catch { /* размеры не обязательны */ }
});

$('#schemForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  withBusy(form, async () => {
    const fd = new FormData(form);
    if (form.dataset.dims) {
      const [w, h, l] = JSON.parse(form.dataset.dims);
      fd.set('width', w); fd.set('height', h); fd.set('length', l);
    }
    store.set('author', form.author.value);
    const { id } = await api('schematics', { method: 'POST', body: fd });
    form.closest('dialog').close();
    await loadSchematics();
    toast('Схематик загружен');
    openSchematic(id);
  });
});

async function loadSchematics() {
  state.schematics = await api('schematics');
  renderSchemList();
  renderMarkers();
  if (v3d.mode === '3d') markers3d();
}

// ---------- Задачи ----------
function renderTasks() {
  for (const col of $$('.column')) {
    const list = state.tasks.filter((t) => t.status === col.dataset.status);
    $('.count', col).textContent = list.length;
    $('.cards', col).innerHTML = list.map((t) => `
      <article class="task" data-id="${t.id}" draggable="true" tabindex="0">
        <h3>${esc(t.title)}</h3>
        ${t.description ? `<p>${esc(t.description)}</p>` : ''}
        ${t.assignee ? `<div class="who">${esc(t.assignee)}</div>` : ''}
      </article>`).join('');
  }
}

function openTask(task) {
  const f = $('#taskForm');
  const editor = isEditor();
  f.reset();
  $('[data-title]', f).textContent = task ? (editor ? 'Задача' : task.title) : 'Новая задача';
  f.dataset.id = task ? task.id : '';
  if (task) {
    f.title.value = task.title; f.description.value = task.description || '';
    f.status.value = task.status; f.assignee.value = task.assignee || '';
  }
  $$('input, textarea, select', f).forEach((el) => (el.disabled = !editor));
  $('button.primary', f).hidden = !editor;
  $('[data-delete]', f).hidden = !editor || !task;
  openDialog('#taskDialog');
}
$('#addTaskBtn').addEventListener('click', () => openTask(null));

$('#taskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  withBusy(form, async () => {
    const body = {
      title: form.title.value, description: form.description.value,
      status: form.status.value, assignee: form.assignee.value,
    };
    if (form.dataset.id) await api('tasks/' + form.dataset.id, { method: 'PATCH', json: body });
    else await api('tasks', { method: 'POST', json: body });
    form.closest('dialog').close();
    await loadTasks();
  });
});
$('#taskForm [data-delete]').addEventListener('click', async () => {
  const form = $('#taskForm');
  if (!confirm('Удалить задачу?')) return;
  try {
    await api('tasks/' + form.dataset.id, { method: 'DELETE' });
    form.closest('dialog').close();
    await loadTasks();
  } catch (err) { showError(form, err.message); }
});

$('.board').addEventListener('click', (e) => {
  const card = e.target.closest('.task');
  if (card) openTask(state.tasks.find((t) => t.id === Number(card.dataset.id)));
});
$('.board').addEventListener('keydown', (e) => {
  const card = e.target.closest('.task');
  if (card && e.key === 'Enter') openTask(state.tasks.find((t) => t.id === Number(card.dataset.id)));
});

// Перетаскивание карточек между колонками (только для редакторов).
let dragId = null;
$('.board').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.task');
  if (!card || !isEditor()) return e.preventDefault();
  dragId = Number(card.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
});
for (const col of $$('.column')) {
  col.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); col.classList.add('drop'); } });
  col.addEventListener('dragleave', () => col.classList.remove('drop'));
  col.addEventListener('drop', async (e) => {
    e.preventDefault();
    col.classList.remove('drop');
    const task = state.tasks.find((t) => t.id === dragId);
    dragId = null;
    if (!task || task.status === col.dataset.status) return;
    const prev = task.status;
    task.status = col.dataset.status;
    renderTasks();
    try { await api('tasks/' + task.id, { method: 'PATCH', json: { status: task.status } }); }
    catch (err) { task.status = prev; renderTasks(); toast(err.message); }
  });
}

async function loadTasks() {
  state.tasks = await api('tasks');
  renderTasks();
}

// ---------- Старт ----------
(async () => {
  if (state.password) {
    try { await api('auth', { method: 'POST' }); setEditor(true); } catch { setEditor(false); }
  }
  try {
    await Promise.all([loadLayers(), loadSchematics(), loadTasks()]);
    renderCityMap();
    fitCity();
    updateBluemapButton();
    if (store.get('mapMode') === '3d' && currentLayer()?.model) setMode('3d');
    const m = location.hash.match(/^#s=(.+)$/);
    if (m) openSchematic(m[1]);
  } catch (err) {
    toast('Не удалось загрузить данные: ' + err.message);
  }
})();
