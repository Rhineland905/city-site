import { parseSchematic, renderTopDown, naturalShare, suggestSlice } from './schem.js';
import { CONFIG } from './config.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const DIM_NAMES = { overworld: 'Верхній світ', nether: 'Незер', end: 'Енд' };
const state = {
  password: store.get('editPassword') || '',
  schematics: [], tasks: [], layers: [], markers: [],
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
    throw new Error(data.error || 'Помилка ' + res.status);
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
  $('#loginBtn').textContent = on ? 'Вийти' : 'Увійти';
  if (!on) { state.password = ''; store.set('editPassword', null); setPlacing(false); stopAreaDraw(); }
  renderPins(); // редактор може перетягувати мітки
  renderMarkersList();
  renderAreas();
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
    toast('Режим редактора увімкнено');
  } catch (err) {
    state.password = '';
    showError(form, err.message);
  }
});

// ---------- Диалоги ----------
function openDialog(sel) {
  const d = $(sel);
  const err = $('[data-error]', d);
  if (err) err.textContent = '';
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
const CENTER = CONFIG.center || { x: 0, y: 64, z: 0 };
const map = L.map('map', {
  crs: L.CRS.Simple, minZoom: -5, maxZoom: 5, zoomSnap: 0.5, attributionControl: false,
}).setView(toLatLng(CENTER.x, CENTER.z), -1);

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
    + '<option value="">Лише сітка</option>';
  sel.value = cur ? cur.id : '';
}

function syncSmoothing() {
  const layer = currentLayer();
  map.getContainer().classList.toggle('map-smooth', !!layer && 2 ** map.getZoom() * layer.scale < 1);
}
map.on('zoomend', syncSmoothing);

function renderCityMap() {
  if (cityImage) { cityImage.remove(); cityImage = null; }
  renderLayerSelect();
  syncMode();
  $('#mapEmpty').hidden = state.layers.length > 0 || state.dim !== 'overworld';
  const layer = currentLayer();
  if (!layer) { syncLive(); return; }
  cityImage = L.imageOverlay(`/api/map/${encodeURIComponent(layer.id)}/image?v=${layer.version}`, layerBounds(layer))
    .addTo(map);
  grid.bringToFront();
  syncSmoothing();
  syncLive();
}

function renderMarkers() {
  markers.clearLayers();
  if (CONFIG.center && state.dim === 'overworld') {
    const { x, y, z } = CONFIG.center;
    const icon = L.divIcon({ className: '', html: '<div class="center-pin"></div>', iconSize: [22, 22] });
    L.marker(toLatLng(x + 0.5, z + 0.5), { icon, title: 'Центр міста', zIndexOffset: -100 })
      .bindTooltip(`Центр міста <span class="mono">X ${x} · Y ${y} · Z ${z}</span>`,
        { className: 'schem-label', direction: 'top', offset: [0, -12] })
      .addTo(markers);
  }
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
// Правий клік: координати, а редактору ще й «поставити мітку» або «додати схематик» у цій точці.
map.on('contextmenu', (e) => {
  const x = Math.floor(e.latlng.lng), z = Math.floor(-e.latlng.lat);
  const box = document.createElement('div');
  box.className = 'ctx-pop';
  box.innerHTML = `<span class="mono">X ${x} · Z ${z}</span>` + (isEditor()
    ? '<button type="button" class="btn" data-mark>Поставити мітку тут</button><button type="button" class="btn" data-schem>Додати схематик тут</button>'
    : '');
  const popup = L.popup().setLatLng(e.latlng).setContent(box).openOn(map);
  box.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-mark]')) { map.closePopup(popup); openMarker(null, { x, z }); }
    if (ev.target.closest('[data-schem]')) { map.closePopup(popup); openSchemDialog({ x, z }); }
  });
});

// ---------- Мітки ----------
// Значки намальовані в сітці 16×16, колір кожного типу задається змінною --c.
const KINDS = {
  home: { label: 'Будинок', color: '#e8b45a', icon: '<path d="M8 1.5 1 7.5h2V15h3.5v-4h3v4H13V7.5h2z"/>' },
  farm: { label: 'Ферма', color: '#8fd14f', icon: '<path d="M7.25 6h1.5v9.5h-1.5z"/><path d="M8 1c1.4 1 1.4 3 0 4-1.4-1-1.4-3 0-4zM4.2 3.6c1.7.1 2.9 1.6 2.6 3.3-1.7-.1-2.9-1.6-2.6-3.3zM11.8 3.6c.3 1.7-.9 3.2-2.6 3.3-.3-1.7.9-3.2 2.6-3.3zM4.2 7.6c1.7.1 2.9 1.6 2.6 3.3-1.7-.1-2.9-1.6-2.6-3.3zM11.8 7.6c.3 1.7-.9 3.2-2.6 3.3-.3-1.7.9-3.2 2.6-3.3z"/>' },
  storage: { label: 'Склад', color: '#d39a5b', icon: '<path d="M1.5 3h13v4.5h-13zM1.5 8.5h13V14h-13z"/><path d="M7 6h2v4H7z" fill="#04080a"/>' },
  mine: { label: 'Шахта', color: '#a9b6c2', icon: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 13.5 10 6.5"/><path d="M5 2.6Q12.6 3.4 13.4 11"/></g>' },
  portal: { label: 'Портал', color: '#c07bff', icon: '<path d="M3 1h10v14H3zm2 2v10h6V3z" fill-rule="evenodd"/><path d="M5 3h6v10H5z" opacity=".45"/>' },
  shop: { label: 'Торгівля', color: '#3fe0a0', icon: '<path d="M5 1.5h6L15 6l-7 8.5L1 6z"/><path d="M1.5 6h13M8 14V6M5.5 1.8 8 6l2.5-4.2" fill="none" stroke="#04080a" stroke-width=".9" opacity=".55"/>' },
  danger: { label: 'Небезпека', color: '#ff6f61', icon: '<path d="M8 1.2 15.2 14.5H.8z"/><path d="M7.1 5.5h1.8v4.8H7.1zM7.1 11.5h1.8v1.8H7.1z" fill="#04080a"/>' },
  other: { label: 'Інше', color: '#22e1e3', icon: '<path d="M8 1.2l2 4.4 4.8.5-3.6 3.2 1 4.7L8 11.6 3.8 14l1-4.7L1.2 6.1 6 5.6z"/>' },
};
const kindOf = (m) => KINDS[m.kind] || KINDS.other;
const kindSvg = (k) => `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${(KINDS[k] || KINDS.other).icon}</svg>`;
const fmtXYZ = (m) => `X ${m.x} · ${m.y === null || m.y === undefined ? '' : `Y ${m.y} · `}Z ${m.z}`;

const pins = L.layerGroup().addTo(map);
const pinById = new Map();
function hiddenKinds() {
  try { return new Set(JSON.parse(store.get('hiddenKinds') || '[]')); } catch { return new Set(); }
}
function visibleMarkers() {
  const hidden = hiddenKinds();
  return state.markers.filter((m) => m.dimension === state.dim && !hidden.has(m.kind));
}

function renderPins() {
  pins.clearLayers();
  pinById.clear();
  const editor = isEditor();
  for (const m of visibleMarkers()) {
    const k = kindOf(m);
    const icon = L.divIcon({ className: '', html: `<div class="mark-pin" style="--c:${k.color}">${kindSvg(m.kind)}</div>`, iconSize: [26, 26] });
    const pin = L.marker(toLatLng(m.x + 0.5, m.z + 0.5), { icon, title: m.name, draggable: editor, riseOnHover: true })
      .bindTooltip(`<span style="--c:${k.color}">${esc(m.name)}</span>`, { permanent: true, direction: 'right', offset: [14, 0], className: 'mark-label' })
      .bindPopup(() => pinPopup(m), { className: 'mark-popup', offset: [0, -10], maxWidth: 300 })
      .on('dragend', (e) => movePin(m, e.target.getLatLng()))
      .on('mouseover', () => pin.getTooltip()?.getElement()?.classList.add('hover'))
      .on('mouseout', () => pin.getTooltip()?.getElement()?.classList.remove('hover'))
      .addTo(pins);
    pinById.set(m.id, pin);
  }
  syncLabels();
}
// Підписи видно, коли мапа наближена. Здалеку лишаються самі значки, щоб написи не злипались.
function syncLabels() { map.getContainer().classList.toggle('labels-off', map.getZoom() < 1); }
map.on('zoomend', syncLabels);

function pinPopup(m) {
  const k = kindOf(m);
  const box = document.createElement('div');
  box.className = 'mark-pop';
  box.style.setProperty('--c', k.color);
  box.innerHTML = `
    <div class="mark-pop-head">${kindSvg(m.kind)}<b>${esc(m.name)}</b></div>
    <div class="muted small">${k.label} · ${DIM_NAMES[m.dimension]}</div>
    <div class="mono">${fmtXYZ(m)}</div>
    ${m.description ? `<p>${esc(m.description)}</p>` : ''}
    <div class="mark-pop-actions">
      <button type="button" class="btn" data-copy>Копіювати координати</button>
      ${isEditor() ? '<button type="button" class="btn" data-edit>Змінити</button>' : ''}
    </div>`;
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-edit]')) { map.closePopup(); openMarker(m); }
    if (e.target.closest('[data-copy]')) {
      const text = `${m.x} ${m.y ?? '~'} ${m.z}`;
      try { await navigator.clipboard.writeText(text); toast(`Скопійовано: ${text}`); } catch { toast(text); }
    }
  });
  return box;
}

async function movePin(m, latlng) {
  const x = Math.floor(latlng.lng), z = Math.floor(-latlng.lat);
  try {
    const saved = await api('markers/' + m.id, { method: 'PATCH', json: { x, z } });
    Object.assign(m, saved);
    toast(`Мітку «${m.name}» переміщено: X ${x} · Z ${z}`);
  } catch (err) {
    toast('Не вдалося перемістити: ' + err.message);
  }
  renderPins();
  renderMarkersList();
}

async function loadMarkers() {
  state.markers = await api('markers');
  renderPins();
  renderKindChips();
  renderMarkersList();
  if (v3d.mode === '3d') markers3d();
}

// --- Список міток з пошуком: щоб швидко знайти, де що є ---
function toggleMarkersPanel(open = $('#markersPanel').hidden) {
  $('#markersPanel').hidden = !open;
  $('#markersBtn').setAttribute('aria-expanded', String(open));
  $('#markersBtn').classList.toggle('on', open);
  if (open) { renderKindChips(); renderMarkersList(); $('#markerSearch').focus({ preventScroll: true }); }
}
$('#markersBtn').addEventListener('click', () => toggleMarkersPanel());
$('#markersClose').addEventListener('click', () => toggleMarkersPanel(false));
$('#markerSearch').addEventListener('input', renderMarkersList);
$('#markerSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#markersList button')?.click();
  if (e.key === 'Escape') toggleMarkersPanel(false);
});

function renderKindChips() {
  const hidden = hiddenKinds();
  const inDim = state.markers.filter((m) => m.dimension === state.dim);
  $('#kindChips').innerHTML = Object.entries(KINDS).map(([key, k]) => {
    const n = inDim.filter((m) => m.kind === key).length;
    return n ? `<button type="button" class="kind-chip" data-kind="${key}" aria-pressed="${!hidden.has(key)}" style="--c:${k.color}" title="Показати або сховати: ${k.label}">${kindSvg(key)}${k.label} <span class="n">${n}</span></button>` : '';
  }).join('');
}
$('#kindChips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-kind]');
  if (!chip) return;
  const hidden = hiddenKinds();
  const key = chip.dataset.kind;
  hidden.has(key) ? hidden.delete(key) : hidden.add(key);
  store.set('hiddenKinds', JSON.stringify([...hidden]));
  renderKindChips();
  renderPins();
  renderMarkersList();
});

function renderMarkersList() {
  const q = $('#markerSearch').value.trim().toLowerCase();
  const list = visibleMarkers().filter((m) => !q || m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q));
  const total = state.markers.filter((m) => m.dimension === state.dim).length;
  $('#markersBtn').innerHTML = total ? `Мітки <span class="count">${total}</span>` : 'Мітки';
  $('#markersList').innerHTML = list.length
    ? list.map((m) => `<li><button type="button" data-id="${m.id}" style="--c:${kindOf(m).color}"><span class="mark-ico">${kindSvg(m.kind)}</span><span class="mark-name">${esc(m.name)}</span><span class="mono muted">${m.x} ${m.z}</span></button></li>`).join('')
    : `<li class="muted small">${total ? 'Нічого не знайдено' : 'Міток ще немає. ' + (isEditor() ? 'Натисни «+ Мітка».' : 'Їх ставлять редактори.')}</li>`;
}
$('#markersList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-id]');
  const m = btn && state.markers.find((x) => String(x.id) === btn.dataset.id);
  if (m) flyToMarker(m);
});

function flyToMarker(m) {
  if (v3d.mode === '3d') setMode('2d');
  if (m.dimension !== state.dim) setDimension(m.dimension);
  map.setView(toLatLng(m.x + 0.5, m.z + 0.5), Math.max(map.getZoom(), 2));
  pinById.get(m.id)?.openPopup();
  if (window.matchMedia('(max-width: 760px)').matches) toggleMarkersPanel(false);
}

// --- Поставити мітку: «+ Мітка», потім клік по мапі ---
let placing = false;
function setPlacing(on) {
  if (on) stopAreaDraw();
  placing = on;
  map.getContainer().classList.toggle('placing', on);
  $('#placeHint').hidden = !on;
  $('#addMarkerBtn').classList.toggle('on', on);
}
$('#addMarkerBtn').addEventListener('click', () => {
  if (v3d.mode === '3d') setMode('2d');
  setPlacing(!placing);
});
$('#placeCancel').addEventListener('click', () => setPlacing(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && placing) setPlacing(false); });
map.on('click', (e) => {
  if (!placing) return;
  setPlacing(false);
  openMarker(null, { x: Math.floor(e.latlng.lng), z: Math.floor(-e.latlng.lat) });
});

// --- Діалог мітки (редактор змінює, решта лише дивиться) ---
function renderKindOptions(f, selected) {
  $('[data-kinds]', f).innerHTML = Object.entries(KINDS).map(([key, k]) =>
    `<label class="kind-opt" style="--c:${k.color}"><input type="radio" name="kind" value="${key}"${key === selected ? ' checked' : ''}><span>${kindSvg(key)}${k.label}</span></label>`
  ).join('');
}
function openMarker(m, prefill = {}) {
  const f = $('#markerForm');
  const editor = isEditor();
  f.reset();
  renderKindOptions(f, m?.kind || store.get('lastKind') || 'other');
  $('[data-title]', f).textContent = m ? (editor ? 'Мітка' : m.name) : 'Нова мітка';
  f.dataset.id = m ? m.id : '';
  f.name.value = m?.name || '';
  f.x.value = m ? m.x : prefill.x ?? '';
  f.y.value = m ? m.y ?? '' : prefill.y ?? '';
  f.z.value = m ? m.z : prefill.z ?? '';
  f.dimension.value = m?.dimension || state.dim;
  f.description.value = m?.description || '';
  const when = m ? new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('uk-UA') : '';
  $('[data-meta]', f).textContent = m ? `Додано ${when}${m.author ? ` · ${m.author}` : ''}` : '';
  $$('input, textarea, select', f).forEach((el) => (el.disabled = !editor));
  $('button.primary', f).hidden = !editor;
  $('[data-delete]', f).hidden = !editor || !m;
  openDialog('#markerDialog');
  if (editor && !m) f.name.focus();
}
$('#markerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  withBusy(form, async () => {
    const body = {
      name: form.name.value, kind: form.kind.value || 'other', description: form.description.value,
      x: form.x.value, y: form.y.value === '' ? null : form.y.value, z: form.z.value,
      dimension: form.dimension.value,
    };
    if (!form.dataset.id) body.author = store.get('author') || '';
    store.set('lastKind', body.kind);
    const saved = form.dataset.id
      ? await api('markers/' + form.dataset.id, { method: 'PATCH', json: body })
      : await api('markers', { method: 'POST', json: body });
    form.closest('dialog').close();
    await loadMarkers();
    toast(`Мітку «${saved.name}» збережено`);
    if (saved.dimension !== state.dim) setDimension(saved.dimension);
    pinById.get(saved.id)?.openPopup();
  });
});
$('#markerForm [data-delete]').addEventListener('click', async () => {
  const form = $('#markerForm');
  const m = state.markers.find((x) => String(x.id) === form.dataset.id);
  if (!m || !confirm(`Видалити мітку «${m.name}»?`)) return;
  try {
    await api('markers/' + m.id, { method: 'DELETE' });
    form.closest('dialog').close();
    await loadMarkers();
    toast('Мітку видалено');
  } catch (err) { showError(form, err.message); }
});

// ---------- Жива мапа ----------
// Мод у грі малює чанки, які прогрузив гравець, і надсилає їх на сайт. Тут вони лягають поверх мапи:
// здалеку мініатюри 16×16 (піксель на блок), зблизька картинки 256×256 (16 пікселів на блок, як у грі).
const live = {
  layerId: null, epoch: null, since: 0, busy: false, polledAt: 0,
  tiles: new Map(), // 'cx,cz' → { hash, at, player }
  minis: new Map(), // 'cx,cz' → 1024 байти RGBA
  imgs: new Map(), // 'cx,cz' → <img> на мапі
  blocks: new Map(), // огляд здалеку: 'bx,bz' → { overlay, url }, квадрат 32×32 чанки
  gen: 0,
};
const OV = 32;
const liveKey = (cx, cz) => cx + ',' + cz;
const liveTileUrl = (cx, cz) =>
  `/api/live/${encodeURIComponent(live.layerId)}/tile/${cx}/${cz}?h=${live.tiles.get(liveKey(cx, cz)).hash}`;

// На масштабі 4 один тайл Leaflet (256 px) — це рівно один чанк, тож координати тайла й чанка збігаються.
const LiveTiles = L.GridLayer.extend({
  createTile(coords, done) {
    const img = document.createElement('img');
    img.alt = '';
    const key = liveKey(coords.x, coords.y);
    live.imgs.set(key, img);
    if (live.tiles.has(key)) loadLiveImg(img, coords.x, coords.y, done);
    else { img.style.visibility = 'hidden'; setTimeout(() => done(null, img), 0); }
    return img;
  },
});
function loadLiveImg(img, cx, cz, done) {
  img.onload = () => { img.style.visibility = ''; done?.(null, img); };
  img.onerror = () => { img.style.visibility = 'hidden'; done?.(null, img); };
  img.src = liveTileUrl(cx, cz);
}
const liveTiles = new LiveTiles({
  pane: 'overlayPane', tileSize: 256, minNativeZoom: 4, maxNativeZoom: 4, minZoom: 3, className: 'live-tiles', zIndex: 2,
});
liveTiles.on('tileunload', (e) => {
  const key = liveKey(e.coords.x, e.coords.y);
  if (live.imgs.get(key) === e.tile) live.imgs.delete(key);
});
const syncLiveSmoothing = () => map.getContainer().classList.toggle('live-soft', map.getZoom() < 4);
map.on('zoomend', syncLiveSmoothing);
syncLiveSmoothing();

// Вмикає живий шар для поточного шару мапи (або прибирає, якщо там жива мапа вимкнена).
function syncLive() {
  const layer = v3d.mode === '3d' ? null : currentLayer();
  const id = layer?.live ? layer.id : null;
  if (id !== live.layerId) {
    live.layerId = id;
    resetLive(layer?.live?.epoch ?? null);
    if (map.hasLayer(liveTiles)) liveTiles.remove();
    if (id) { liveTiles.addTo(map); pollLive(); }
  } else {
    for (const b of live.blocks.values()) b.overlay.bringToFront();
  }
  grid.bringToFront();
  renderLiveBadge();
  renderAreas();
}
function resetLive(epoch) {
  live.epoch = epoch;
  live.since = 0;
  live.gen++;
  live.tiles.clear();
  live.minis.clear();
  for (const b of live.blocks.values()) { b.overlay.remove(); URL.revokeObjectURL(b.url); }
  live.blocks.clear();
}

async function pollLive() {
  if (!live.layerId || live.busy) return;
  live.busy = true;
  try {
    for (let round = 0; round < 2; round++) {
      const id = live.layerId, since = live.since;
      const data = await api(`live/${encodeURIComponent(id)}?since=${since}`);
      if (id !== live.layerId) return;
      if ((data.live?.epoch ?? null) !== live.epoch) {
        // Чанки стерли або змінили зріз: починаємо спочатку.
        resetLive(data.live?.epoch ?? null);
        liveTiles.redraw();
        if (data.live) continue;
        return;
      }
      const changed = [];
      for (const [cx, cz, hash, at, player] of data.tiles) {
        const key = liveKey(cx, cz);
        if (live.tiles.get(key)?.hash !== hash) changed.push([cx, cz]);
        live.tiles.set(key, { hash, at, player });
        if (at > live.since) live.since = at;
      }
      if (!changed.length) return;
      const res = await fetch(`/api/live/${encodeURIComponent(id)}/minis?since=${since}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Помилка ' + res.status);
      const buf = await res.arrayBuffer();
      if (id !== live.layerId) return;
      const dv = new DataView(buf);
      const got = [];
      for (let o = 0; o + 1032 <= buf.byteLength; o += 1032) {
        const cx = dv.getInt32(o), cz = dv.getInt32(o + 4);
        live.minis.set(liveKey(cx, cz), new Uint8ClampedArray(buf, o + 8, 1024));
        got.push([cx, cz]);
      }
      await drawLiveOverview(got);
      for (const [cx, cz] of changed) {
        const img = live.imgs.get(liveKey(cx, cz));
        if (img) loadLiveImg(img, cx, cz);
      }
      return;
    }
  } catch (err) {
    console.warn('Жива мапа:', err);
  } finally {
    live.busy = false;
    live.polledAt = Date.now();
    renderLiveBadge();
  }
}
setInterval(() => { if (!document.hidden) pollLive(); }, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - live.polledAt > 60_000) pollLive();
});

// Огляд здалеку: мініатюри, піксель на блок, як і сама мапа міста. Мапа поділена на квадрати 32×32 чанки,
// тож далекі області не роздувають одну картинку, а перемальовується лише квадрат, де щось змінилося.
async function drawLiveOverview(chunks) {
  const gen = live.gen;
  const blocks = new Set(chunks.map(([cx, cz]) => Math.floor(cx / OV) + ',' + Math.floor(cz / OV)));
  for (const bk of blocks) {
    const [bx, bz] = bk.split(',').map(Number);
    const c = document.createElement('canvas');
    c.width = c.height = OV * 16;
    const g = c.getContext('2d');
    const img = g.createImageData(16, 16);
    for (let j = 0; j < OV; j++) {
      for (let i = 0; i < OV; i++) {
        const px = live.minis.get(liveKey(bx * OV + i, bz * OV + j));
        if (!px) continue;
        img.data.set(px);
        g.putImageData(img, i * 16, j * 16);
      }
    }
    const blob = await new Promise((resolve) => c.toBlob(resolve));
    if (!blob || gen !== live.gen) return;
    const url = URL.createObjectURL(blob);
    const old = live.blocks.get(bk);
    if (old) {
      old.overlay.setUrl(url);
      URL.revokeObjectURL(old.url);
      old.url = url;
    } else {
      const bounds = L.latLngBounds(toLatLng(bx * OV * 16, bz * OV * 16), toLatLng((bx + 1) * OV * 16, (bz + 1) * OV * 16));
      live.blocks.set(bk, { overlay: L.imageOverlay(url, bounds, { className: 'live-overview' }).addTo(map), url });
    }
  }
  grid.bringToFront();
}

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'щойно';
  if (s < 3600) return `${Math.round(s / 60)} хв тому`;
  if (s < 86400) return `${Math.round(s / 3600)} год тому`;
  return new Date(ms).toLocaleDateString('uk-UA');
}
function liveLatest() {
  let best = null;
  for (const t of live.tiles.values()) if (!best || t.at > best.at) best = t;
  return best;
}
function renderLiveBadge() {
  const btn = $('#liveBtn');
  const latest = liveLatest();
  btn.classList.toggle('on', !!latest && Date.now() - latest.at < 15 * 60_000);
  btn.innerHTML = '<span class="live-dot" aria-hidden="true"></span>Жива мапа'
    + (live.tiles.size ? ` <span class="count">${live.tiles.size}</span>` : '');
  btn.title = latest ? `Оновлено ${ago(latest.at)}${latest.player ? ', ' + latest.player : ''}` : 'Мод, який сам оновлює мапу з гри';
  if ($('#liveDialog').open) renderLiveStatus();
}

// --- Вікно «Жива мапа» ---
const plural = (one, few, many) => (n) => {
  const d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return one;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
};
const chunksWord = plural('чанк', 'чанки', 'чанків');
const areasWord = plural('область', 'області', 'областей');
const blocksWord = plural('блок', 'блоки', 'блоків');
function renderLiveStatus() {
  const el = $('#liveStatus');
  const layer = currentLayer();
  const anyLive = state.layers.some((l) => l.live);
  if (layer?.live && live.layerId === layer.id) {
    const latest = liveLatest();
    const n = layer.liveAreas?.length || 0;
    const areas = n ? ` Мод оновлює ще ${n} ${areasWord(n)} поза мапою або з іншим зрізом.` : '';
    el.innerHTML = (latest
      ? `Шар «${esc(layer.name)}»: <b>${live.tiles.size} ${chunksWord(live.tiles.size)}</b> з гри, востаннє ${ago(latest.at)}${latest.player ? ` (${esc(latest.player)})` : ''}.`
      : `Шар «${esc(layer.name)}» чекає на перші чанки з гри. Зріз: Y від ${layer.live.top} до ${layer.live.bottom}.`) + areas;
  } else if (anyLive) {
    el.textContent = 'На цьому шарі жива мапа вимкнена. Вибери шар, де вона ввімкнена.';
  } else {
    el.textContent = 'Жива мапа ще не ввімкнена. Її вмикає редактор нижче в цьому вікні.';
  }
}

function renderLiveLayers() {
  const box = $('#liveLayers');
  if (!state.layers.length) { box.innerHTML = '<p class="live-note">Спершу додай шар мапи.</p>'; return; }
  box.innerHTML = state.layers.map((l) => {
    const top = l.live?.top ?? l.model?.sliceTop ?? '';
    const bottom = l.live?.bottom ?? l.model?.sliceBottom ?? '';
    return `<div class="live-layer" data-id="${esc(l.id)}">
      <label class="check"><input type="checkbox" data-on ${l.live ? 'checked' : ''}> ${esc(l.name)} <span class="muted">· ${DIM_NAMES[l.dimension]}</span></label>
      <label>Зріз згори, Y<input type="number" step="1" data-top value="${esc(top)}"></label>
      <label>знизу, Y<input type="number" step="1" data-bottom value="${esc(bottom)}"></label>
      <button type="button" class="btn" data-save>Зберегти</button>
      <button type="button" class="btn danger" data-clear ${l.live ? '' : 'disabled'}>Стерти чанки</button>
      <p class="live-msg" data-msg></p>
      ${l.live ? renderAreaList(l) : ''}
    </div>`;
  }).join('');
}
const areaName = (l, a) => a.name || `Область ${(l.liveAreas || []).indexOf(a) + 1}`;
function renderAreaList(l) {
  const areas = l.liveAreas || [];
  const items = areas.map((a) => `<li data-area="${esc(a.id)}">
      <span class="live-area-name">${esc(areaName(l, a))}</span>
      <span class="mono">X ${a.minX}…${a.maxX} · Z ${a.minZ}…${a.maxZ}</span>
      <span class="mono live-area-y${a.top !== l.live.top || a.bottom !== l.live.bottom ? ' own' : ''}">Y ${a.top}…${a.bottom}</span>
      <span class="live-area-btns"><button type="button" class="btn" data-area-show>Показати</button><button type="button" class="btn" data-area-edit>Змінити</button></span>
    </li>`).join('');
  return `<div class="live-areas">
    <div class="live-areas-head"><span>Області${areas.length ? ` · ${areas.length}` : ''}</span><button type="button" class="btn" data-area-add>+ Область</button></div>
    ${areas.length ? `<ul>${items}</ul>`
      : '<p class="live-note">Поки мод оновлює лише сам шар і 32 блоки навколо. Намалюй область на мапі, щоб розширити територію або показати частину міста нижче чи вище.</p>'}
  </div>`;
}

async function renderLiveKey(created) {
  const box = $('#liveKeyBox');
  if (created) {
    const cmd = `/citymap key ${created}`;
    box.innerHTML = `<p>Новий ключ. Скопіюй команду й передай гравцям із модом: потім ключ більше не показується.</p>
      <div class="row"><input readonly value="${esc(cmd)}" aria-label="Команда з ключем"><button type="button" class="btn primary" data-copy>Копіювати</button></div>`;
    $('[data-copy]', box).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(cmd); toast('Команду скопійовано'); }
      catch { $('input', box).select(); toast('Виділи й скопіюй команду вручну'); }
    });
    return;
  }
  box.innerHTML = '<p class="live-note">Перевіряю ключ…</p>';
  try {
    const k = await api('live/key');
    box.innerHTML = k.exists
      ? `<p>Ключ для мода створено ${new Date(k.createdAt).toLocaleDateString('uk-UA')}. Його видно лише один раз, тож якщо він загубився, створи новий: старий перестане працювати.</p>
         <div class="row"><button type="button" class="btn" data-newkey>Створити новий ключ</button></div>`
      : `<p>Ключа ще немає. Створи його й дай гравцям, у яких стоїть мод: без ключа мод нічого не надсилає.</p>
         <div class="row"><button type="button" class="btn primary" data-newkey>Створити ключ</button></div>`;
    $('[data-newkey]', box).addEventListener('click', async (e) => {
      if (k.exists && !confirm('Створити новий ключ? Старий перестане працювати, і гравцям доведеться ввести новий.')) return;
      e.target.disabled = true;
      try { renderLiveKey((await api('live/key', { method: 'POST' })).key); }
      catch (err) { toast(err.message); e.target.disabled = false; }
    });
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

$('#liveBtn').addEventListener('click', () => {
  renderLiveStatus();
  if (isEditor()) { renderLiveKey(); renderLiveLayers(); }
  openDialog('#liveDialog');
});
$('#liveLayers').addEventListener('click', async (e) => {
  const row = e.target.closest('.live-layer');
  const btn = e.target.closest('button');
  if (!row || !btn) return;
  const id = row.dataset.id;
  const layer = state.layers.find((l) => l.id === id);
  if (btn.matches('[data-area-add]')) { if (layer) startAreaDraw(layer); return; }
  const li = btn.closest('[data-area]');
  if (li) {
    const area = layer?.liveAreas?.find((a) => a.id === li.dataset.area);
    if (!area) return;
    if (btn.matches('[data-area-edit]')) openArea(layer, area);
    if (btn.matches('[data-area-show]')) {
      $('#liveDialog').close();
      useLayer(layer);
      map.fitBounds(areaBounds(area), { maxZoom: 3, padding: [40, 40] });
      flashArea(area.id);
    }
    return;
  }
  const msg = $('[data-msg]', row);
  msg.textContent = '';
  msg.classList.remove('bad');
  btn.disabled = true;
  let done = '';
  try {
    if (btn.matches('[data-save]')) {
      const enabled = $('[data-on]', row).checked;
      const top = $('[data-top]', row).value, bottom = $('[data-bottom]', row).value;
      if (enabled && (top === '' || bottom === '')) throw new Error('Вкажи зріз згори і знизу');
      await api('live/' + encodeURIComponent(id), { method: 'PATCH', json: { enabled, top: Number(top), bottom: Number(bottom) } });
      done = enabled ? 'Збережено: жива мапа ввімкнена.' : 'Живу мапу на цьому шарі вимкнено.';
    } else if (btn.matches('[data-clear]')) {
      if (!confirm('Стерти всі чанки з гри на цьому шарі? Мод намалює їх знову, коли гравці там пройдуть.')) return;
      await api('live/' + encodeURIComponent(id), { method: 'DELETE' });
      done = 'Чанки стерто.';
    }
    await loadLayers();
    live.layerId = null; // перечитати шар із новими налаштуваннями
    renderCityMap();
    renderLiveLayers();
    renderLiveStatus();
    const fresh = $(`.live-layer[data-id="${CSS.escape(id)}"] [data-msg]`);
    if (fresh) fresh.textContent = done;
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add('bad');
  } finally {
    btn.disabled = false;
  }
});

// --- Області живої мапи: прямокутники, які мод оновлює теж, кожен може мати свій зріз ---
map.createPane('areasPane').style.zIndex = 450; // над мапою й чанками, під мітками
const areaRenderer = L.svg({ pane: 'areasPane' });
const areaShapes = L.layerGroup().addTo(map);
const AREA_STYLE = {
  pane: 'areasPane', renderer: areaRenderer, color: '#22e1e3', weight: 2, dashArray: '6 5',
  fillColor: '#22e1e3', fillOpacity: 0.05,
};
const areaBounds = (a) => L.latLngBounds(toLatLng(a.minX, a.minZ), toLatLng(a.maxX + 1, a.maxZ + 1));
// Межі рівняються до чанків, як і на сервері.
function snapArea(x0, z0, x1, z1) {
  const lo = (v) => Math.floor(v / 16) * 16, hi = (v) => Math.floor(v / 16) * 16 + 15;
  return { minX: lo(Math.min(x0, x1)), maxX: hi(Math.max(x0, x1)), minZ: lo(Math.min(z0, z1)), maxZ: hi(Math.max(z0, z1)) };
}

// Обриси видно лише редактору: гостям досить самих чанків. Клікається лише ярлик у кутку,
// щоб клік усередині області лишався звичайним кліком по мапі.
function renderAreas() {
  areaShapes.clearLayers();
  const layer = v3d.mode === '3d' ? null : currentLayer();
  if (!layer?.live || !isEditor()) return;
  for (const a of layer.liveAreas || []) {
    const own = a.top !== layer.live.top || a.bottom !== layer.live.bottom;
    const rect = L.rectangle(areaBounds(a), { ...AREA_STYLE, interactive: false, className: 'live-area' + (own ? ' own' : '') });
    rect.areaId = a.id;
    rect.addTo(areaShapes);
    const icon = L.divIcon({
      className: '', iconSize: null, iconAnchor: [0, 0],
      html: `<span class="area-tag${own ? ' own' : ''}" title="Змінити область">${esc(areaName(layer, a))} <span class="mono">Y ${a.top}…${a.bottom}</span></span>`,
    });
    L.marker(toLatLng(a.minX, a.minZ), { icon, zIndexOffset: -200, title: areaName(layer, a) })
      .on('click', () => { if (!draw.layer && !placing) openArea(layer, a); })
      .addTo(areaShapes);
  }
}
function flashArea(id) {
  areaShapes.eachLayer((r) => {
    if (r.areaId !== id) return;
    const el = r.getElement();
    el?.classList.remove('flash');
    void el?.getBoundingClientRect();
    el?.classList.add('flash');
  });
}
function useLayer(layer) {
  if (v3d.mode === '3d') setMode('2d');
  if (state.dim !== layer.dimension) {
    state.layerId = layer.id;
    store.set('layerId', layer.id);
    setDimension(layer.dimension);
  } else if (currentLayer()?.id !== layer.id) {
    state.layerId = layer.id;
    store.set('layerId', layer.id);
    renderCityMap();
  }
}

// Малювання: два кліки по протилежних кутах. Так само працює і пальцем на телефоні.
const draw = { layer: null, a: null, rect: null };
function areaHint(text) {
  $('#areaHint [data-text]').textContent = text;
  $('#areaHint').hidden = false;
}
function startAreaDraw(layer) {
  $('#liveDialog').close();
  useLayer(layer);
  setPlacing(false);
  stopAreaDraw();
  draw.layer = layer;
  map.getContainer().classList.add('placing');
  areaHint('Клацни на мапі перший кут області.');
}
function stopAreaDraw() {
  if (!draw.layer) return;
  draw.layer = null;
  draw.a = null;
  draw.rect?.remove();
  draw.rect = null;
  map.getContainer().classList.remove('placing');
  $('#areaHint').hidden = true;
}
$('#areaCancel').addEventListener('click', stopAreaDraw);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && draw.layer) stopAreaDraw(); });
const blockAt = (latlng) => [Math.floor(latlng.lng), Math.floor(-latlng.lat)];
map.on('click', (e) => {
  if (!draw.layer) return;
  const [x, z] = blockAt(e.latlng);
  if (!draw.a) {
    draw.a = [x, z];
    draw.rect = L.rectangle(areaBounds(snapArea(x, z, x, z)), { ...AREA_STYLE, interactive: false, className: 'live-area drawing' })
      .addTo(map);
    areaHint('Тепер клацни протилежний кут.');
    return;
  }
  const layer = draw.layer;
  const b = snapArea(draw.a[0], draw.a[1], x, z);
  stopAreaDraw();
  openArea(layer, null, b);
});
map.on('mousemove', (e) => {
  if (!draw.a || !draw.rect) return;
  const [x, z] = blockAt(e.latlng);
  draw.rect.setBounds(areaBounds(snapArea(draw.a[0], draw.a[1], x, z)));
});

const AREA_FIELDS = ['name', 'minX', 'maxX', 'minZ', 'maxZ', 'top', 'bottom'];
function openArea(layer, area, bounds) {
  const f = $('#areaForm');
  f.reset();
  f.dataset.layer = layer.id;
  f.dataset.id = area?.id || '';
  const v = area || { ...bounds, name: '', top: layer.live?.top ?? '', bottom: layer.live?.bottom ?? '' };
  for (const k of AREA_FIELDS) f.elements[k].value = v[k] ?? '';
  $('[data-title]', f).textContent = area ? areaName(layer, area) : 'Нова область';
  $('[data-delete]', f).hidden = !area;
  renderAreaSize();
  openDialog('#areaDialog');
}
function renderAreaSize() {
  const f = $('#areaForm');
  const layer = state.layers.find((l) => l.id === f.dataset.layer);
  const n = (k) => (f.elements[k].value.trim() === '' ? NaN : Number(f.elements[k].value));
  const parts = [];
  if (['minX', 'maxX', 'minZ', 'maxZ'].every((k) => Number.isFinite(n(k)))) {
    const b = snapArea(n('minX'), n('minZ'), n('maxX'), n('maxZ'));
    const w = b.maxX - b.minX + 1, h = b.maxZ - b.minZ + 1, chunks = (w / 16) * (h / 16);
    parts.push(`${w} × ${h} ${blocksWord(h)}, ${chunks} ${chunksWord(chunks)}.`);
  }
  if (layer?.live) {
    parts.push(`Основний зріз шару: Y ${layer.live.top}…${layer.live.bottom}. Щоб показати поверх нижче чи вище, зміни зріз тут.`);
  }
  $('[data-size]', f).textContent = parts.join(' ');
}
$('#areaForm').addEventListener('input', renderAreaSize);
async function afterAreaChange(layerId, r, saved) {
  await loadLayers();
  if (r.erased) live.layerId = null; // чанки стерлися: перечитуємо живий шар з нуля
  renderCityMap();
  const text = saved + (r.erased ? ` Стерто старих чанків: ${r.erased}, мод намалює їх заново.` : '');
  if ($('#liveDialog').open) {
    // Тост сховався б під вікном, тож пишемо в рядок шару.
    renderLiveLayers();
    const msg = $(`.live-layer[data-id="${CSS.escape(layerId)}"] [data-msg]`);
    if (msg) msg.textContent = text;
  } else {
    toast(text);
  }
}
$('#areaForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    const id = f.dataset.id;
    const json = Object.fromEntries(AREA_FIELDS.map((k) => [k, f.elements[k].value]));
    const r = await api(`live/${encodeURIComponent(f.dataset.layer)}/areas${id ? '/' + encodeURIComponent(id) : ''}`,
      { method: id ? 'PUT' : 'POST', json });
    f.closest('dialog').close();
    await afterAreaChange(f.dataset.layer, r, id ? 'Область збережено.' : 'Область додано: мод оновлюватиме її, коли гравці там ходять.');
    if (r.area) flashArea(r.area.id);
  });
});
$('#areaForm [data-delete]').addEventListener('click', async (e) => {
  const f = $('#areaForm');
  if (!confirm('Видалити область? Чанки, які мод малював лише для неї, зітруться.')) return;
  e.target.disabled = true;
  try {
    const r = await api(`live/${encodeURIComponent(f.dataset.layer)}/areas/${encodeURIComponent(f.dataset.id)}`, { method: 'DELETE' });
    f.closest('dialog').close();
    await afterAreaChange(f.dataset.layer, r, 'Область видалено.');
  } catch (err) {
    showError(f, err.message);
  } finally {
    e.target.disabled = false;
  }
});

function setDimension(dim) {
  state.dim = dim;
  $('#dimSelect').value = dim;
  renderCityMap();
  renderMarkers();
  renderPins();
  renderKindChips();
  renderMarkersList();
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
  syncLive();
}
$$('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function v3dStatus(text) {
  const el = $('#v3dStatus');
  el.hidden = !text;
  el.textContent = text || '';
}

// Середні кольори блоків із текстур гри: зберігаються, коли мапу малюють із .jar. Потрібні для 3D.
let blockColorsCache = null;
function getBlockColors() {
  blockColorsCache ??= fetch('/api/colors').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return blockColorsCache;
}

async function show3d() {
  const layer = currentLayer();
  if (!layer?.model) return setMode('2d');
  const key = `${layer.id}:${layer.model.version}`;
  try {
    if (v3d.key !== key) {
      v3dStatus('Завантажую 3D-модель міста…');
      const [{ createViewer }, buf, colors] = await Promise.all([
        import('./voxel.js'),
        fetch(`/api/map/${encodeURIComponent(layer.id)}/model?v=${layer.model.version}`).then((r) => {
          if (!r.ok) throw new Error('модель не знайдено');
          return r.arrayBuffer();
        }),
        getBlockColors(),
      ]);
      v3dStatus('Будую місто з блоків…');
      await new Promise((r) => setTimeout(r, 30));
      const schem = await parseSchematic(buf, layer.model.fileName);
      v3d.viewer ??= createViewer($('#v3dCanvas'));
      v3d.schem = schem;
      v3d.colors = colors;
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
    v3dStatus('Не вдалося відкрити 3D: ' + err.message);
  }
}

function build3d(keepView) {
  v3d.viewer.setModel(v3d.schem, { hideNatural: $('#v3dRock').checked, keepView, colors: v3d.colors });
  applyClip();
}
function applyClip() {
  const clip = $('#v3dClip');
  const y = Number(clip.value);
  $('#v3dClipVal').textContent = y >= Number(clip.max) ? 'усе місто' : 'Y ' + y;
  if (v3d.viewer && v3d.layer?.model) v3d.viewer.setClip(y - v3d.layer.model.minY + 1);
}
$('#v3dClip').addEventListener('input', applyClip);
$('#v3dRock').addEventListener('change', () => {
  if (!v3d.schem) return;
  v3dStatus('Перебудовую…');
  setTimeout(() => { build3d(true); v3dStatus(''); }, 30);
});

function markers3d() {
  const layer = v3d.layer;
  if (!v3d.viewer || !layer?.model || !v3d.schem) return;
  const { width: W, height: H, length: L } = v3d.schem;
  const at = (o) => ({ x: o.x - layer.originX, y: o.y - layer.model.minY, z: o.z - layer.originZ });
  const list = [
    ...state.schematics.filter((s) => s.dimension === layer.dimension)
      .map((s) => ({ id: 's' + s.id, label: s.name, ...at(s) })),
    // Мітки без Y у 3D не показуємо: невідомо, на якій висоті їх ставити.
    ...state.markers.filter((m) => m.dimension === layer.dimension && m.y !== null)
      .map((m) => ({ id: 'm' + m.id, label: m.name, color: kindOf(m).color, ...at(m) })),
  ].filter((m) => m.x > -16 && m.z > -16 && m.x < W + 16 && m.z < L + 16 && m.y > -16 && m.y < H + 16);
  v3d.viewer.setMarkers(list, (id) => {
    if (id.startsWith('s')) return openSchematic(id.slice(1));
    const m = state.markers.find((x) => 'm' + x.id === id);
    if (m) openMarker(m);
  });
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
  select.innerHTML = (allowNew ? '<option value="">Новий шар</option>' : '')
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
    toast(`Шар «${layer.name}» збережено`);
  });
});
$('#mapForm [data-delete]').addEventListener('click', async () => {
  const form = $('#mapForm');
  const layer = state.layers.find((l) => l.id === form.layerId.value);
  if (!layer || !confirm(`Видалити шар «${layer.name}»?`)) return;
  try {
    await api('map/' + encodeURIComponent(layer.id), { method: 'DELETE' });
    form.closest('dialog').close();
    await loadLayers();
    renderCityMap();
    toast('Шар видалено');
  } catch (err) { showError(form, err.message); }
});

// --- Слой из схематика всего города ---
// Текстуры из файла игры подгружаются отдельным модулем: он нужен только редактору.
const fromSchem = { schem: null, file: null, timer: 0, assets: null, texName: '', tiles: null, job: 0 };
const loadTextures = () => import('./textures.js');
const MB = 1024 * 1024;
const TEX_HINT = $('#fromSchemForm [data-tex-info]').innerHTML;

$('#fromSchemBtn').addEventListener('click', () => {
  const f = $('#fromSchemForm');
  f.reset();
  fromSchem.schem = null;
  fromSchem.tiles = null;
  $('fieldset', f).disabled = true;
  $('[data-info]', f).textContent = 'Велике місто може читатися кілька секунд.';
  $('[data-save-status]', f).textContent = '';
  if (fromSchem.assets) $('[data-tex-info]', f).textContent = `Текстури вже вибрано: ${fromSchem.texName}. Можна вибрати інший файл.`;
  else $('[data-tex-info]', f).innerHTML = TEX_HINT;
  $('[data-preview]', f).innerHTML = '<span class="muted">Тут з’явиться мапа</span>';
  fillLayerSelect(f.layerId);
  const underground = state.layers.find((l) => /підзем|подзем/i.test(l.name));
  if (underground) { f.layerId.value = underground.id; f.name.value = underground.name; }
  f.dimension.value = state.dim;
  fillCorner(f, underground);
  openDialog('#fromSchemDialog');
});
// Шар зі схематика пам’ятає свій найменший кут і зріз, тож при перемальовуванні все вже стоїть.
function fillCorner(f, layer) {
  if (!layer?.model) return;
  f.minX.value = layer.originX;
  f.minY.value = layer.model.minY;
  f.minZ.value = layer.originZ;
  if (layer.model.sliceTop !== undefined) {
    f.topY.value = layer.model.sliceTop;
    f.bottomY.value = layer.model.sliceBottom;
  }
}

$('#fromSchemForm').file.addEventListener('change', async (e) => {
  const f = e.target.form;
  const file = e.target.files[0];
  const info = $('[data-info]', f);
  fromSchem.schem = null;
  fromSchem.tiles = null;
  $('fieldset', f).disabled = true;
  if (!file) return;
  info.textContent = 'Читаю схематик…';
  showError(f, '');
  try {
    await new Promise((r) => setTimeout(r, 30)); // дать браузеру обновить текст
    const schem = await parseSchematic(await file.arrayBuffer(), file.name);
    fromSchem.schem = schem;
    fromSchem.file = file;
    info.textContent = `${schem.width}×${schem.height}×${schem.length} блоків (ширина × висота × довжина).`;
    // Зріз: збережений у шарі, інакше від підлоги до верху будинків.
    const minY = Number(f.minY.value) || 0;
    const inside = (v) => v !== '' && Number(v) >= minY && Number(v) <= minY + schem.height - 1;
    if (!inside(f.topY.value) || !inside(f.bottomY.value)) {
      const s = suggestSlice(schem) || { top: schem.height - 1, bottom: 0 };
      f.topY.value = minY + s.top;
      f.bottomY.value = minY + s.bottom;
    }
    $('fieldset', f).disabled = false;
    drawFromSchemPreview();
    prepareTiles(f);
  } catch (err) {
    console.error(err);
    info.textContent = '';
    showError(f, 'Не вдалося прочитати схематик: ' + err.message);
  }
});

$('#fromSchemForm').textures.addEventListener('change', async (e) => {
  const f = e.target.form;
  const files = [...e.target.files];
  const info = $('[data-tex-info]', f);
  if (!files.length) return;
  fromSchem.assets = null;
  fromSchem.tiles = null;
  info.textContent = 'Відкриваю файл гри…';
  try {
    const { openPacks } = await loadTextures();
    fromSchem.assets = await openPacks(files);
    fromSchem.texName = fromSchem.assets.version ? `Minecraft ${fromSchem.assets.version}` : files.map((x) => x.name).join(', ');
    info.textContent = `Текстури: ${fromSchem.texName}.` + (fromSchem.schem ? '' : ' Тепер вибери схематик.');
    await prepareTiles(f);
  } catch (err) {
    console.error(err);
    info.textContent = 'Не вдалося прочитати текстури: ' + err.message;
  }
});

// Плитки «вид згори» для кожного блока схематика. Готуються раз на пару «схематик + текстури».
async function prepareTiles(f) {
  if (!fromSchem.schem || !fromSchem.assets) return;
  const job = ++fromSchem.job;
  const info = $('[data-tex-info]', f);
  const { buildTiles, pickPx } = await loadTextures();
  const schem = fromSchem.schem;
  const tiles = await buildTiles(fromSchem.assets, schem.states, (done, total) => {
    if (job === fromSchem.job) info.textContent = `Збираю блоки з текстур: ${done} з ${total}…`;
  });
  if (job !== fromSchem.job || schem !== fromSchem.schem) return; // поки збирали, вибрали інший файл
  fromSchem.tiles = tiles;
  const px = pickPx(schem.width, schem.length);
  info.textContent = `Текстури: ${fromSchem.texName}. Мапа буде ${px} пікс. на блок (${schem.width * px}×${schem.length * px}).`
    + (tiles.missing ? ` Блоків без текстури (з модів): ${tiles.missing}, вони будуть кольорові.` : '');
  drawFromSchemPreview();
}

async function fromSchemCanvas(px) {
  const f = $('#fromSchemForm');
  const minY = Number(f.minY.value) || 0;
  const opts = { topY: Number(f.topY.value) - minY, bottomY: Number(f.bottomY.value) - minY };
  if (!fromSchem.tiles) return renderTopDown(fromSchem.schem, opts);
  const { renderTextured } = await loadTextures();
  return renderTextured(fromSchem.schem, fromSchem.tiles, { ...opts, px });
}
async function drawFromSchemPreview() {
  if (!fromSchem.schem) return;
  const { width: W, length: L } = fromSchem.schem;
  const px = fromSchem.tiles ? (await loadTextures()).pickPx(W, L, 4, 1.5e6) : 1;
  const canvas = await fromSchemCanvas(px);
  canvas.classList.toggle('smooth', px > 1); // зменшене прев’ю з текстурами згладжуємо, щоб не рябіло
  const box = $('#fromSchemForm [data-preview]');
  box.innerHTML = '';
  box.appendChild(canvas);
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
  fillCorner(e.target.form, layer);
  drawFromSchemPreview();
});

// Картинка мапи для сховища (до 24 МБ): маленька — PNG без втрат, велика — WebP, де його немає — JPEG.
async function encodeMap(canvas) {
  const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  if (canvas.width * canvas.height <= 4e6) {
    const png = await toBlob('image/png');
    if (png && png.size <= 24 * MB) return png;
  }
  const webp = await toBlob('image/webp', 0.9);
  if (webp && webp.type === 'image/webp' && webp.size <= 24 * MB) return webp;
  return toBlob('image/jpeg', 0.9);
}

$('#fromSchemForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const status = $('[data-save-status]', form);
  withBusy(form, async () => {
    if (!fromSchem.schem) throw new Error('Спершу вибери схематик');
    if (Number(form.topY.value) < Number(form.bottomY.value)) throw new Error('Верх зрізу має бути вище за низ');
    const { width: W, length: L } = fromSchem.schem;
    const tx = fromSchem.tiles ? await loadTextures() : null;
    let px = tx ? tx.pickPx(W, L) : 1;
    let canvas, blob;
    try {
      for (;;) {
        status.textContent = `Малюю мапу ${W * px}×${L * px}…`;
        await new Promise((r) => setTimeout(r, 30));
        try {
          canvas = await fromSchemCanvas(px);
          status.textContent = 'Стискаю картинку…';
          blob = await encodeMap(canvas);
        } catch (err) {
          if (px === 1) throw err;
          console.warn(err); // браузер не потягнув такий розмір (так буває в Safari): пробуємо менший
          blob = null;
        }
        if (blob && blob.size <= 24 * MB) break;
        if (px === 1) throw new Error('Мапа вийшла більшою за 24 МБ. Зменш схематик або розділи місто на частини');
        px /= 2; // не влізло: удвічі менше пікселів на блок
      }
      const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[blob.type] || 'png';
      const fd = new FormData();
      fd.set('image', new File([blob], `map.${ext}`, { type: blob.type }));
      fd.set('layerId', form.layerId.value);
      fd.set('name', form.name.value || 'Підземне місто');
      fd.set('dimension', form.dimension.value);
      fd.set('originX', form.minX.value);
      fd.set('originZ', form.minZ.value);
      fd.set('scale', 1 / px);
      fd.set('width', canvas.width);
      fd.set('height', canvas.height);
      fd.set('model', fromSchem.file);
      fd.set('modelMinY', form.minY.value);
      fd.set('sliceTop', form.topY.value);
      fd.set('sliceBottom', form.bottomY.value);
      if (tx) fd.set('colors', JSON.stringify(tx.blockColors(fromSchem.schem, fromSchem.tiles)));
      status.textContent = `Завантажую ${(blob.size / MB).toFixed(1)} МБ…`;
      const layer = await api('map', { method: 'POST', body: fd });
      blockColorsCache = null;
      form.closest('dialog').close();
      await showSavedLayer(layer);
      toast(`Шар «${layer.name}» збережено`);
    } finally {
      status.textContent = '';
    }
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
    : `<p class="empty">${q ? 'Нічого не знайшлося' : 'Схематиків поки немає. Увійди як редактор і завантаж перший.'}</p>`;
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
    <div class="meta muted">${s.author ? 'Автор: ' + esc(s.author) + ' · ' : ''}${new Date(s.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('uk')}</div>
    <div class="preview" id="previewBox"><div class="status">Завантажую прев’ю…</div></div>
    <dl>
      <dt>Координати</dt><dd class="mono">X ${s.x} · Y ${s.y} · Z ${s.z}</dd>
      <dt>Вимір</dt><dd>${DIM_NAMES[s.dimension] || esc(s.dimension)}</dd>
      ${dims(s) ? `<dt>Розмір</dt><dd class="mono">${dims(s)} блоків</dd>` : ''}
      <dt>Файл</dt><dd>${esc(s.file_name)} · ${fmtSize(s.file_size)}</dd>
    </dl>
    ${s.description ? `<p class="desc">${esc(s.description)}</p>` : ''}
    <div class="actions">
      <a class="btn primary" href="/api/schematics/${esc(s.id)}/file" download>Скачати</a>
      <button class="btn" data-act="tp">Скопіювати /tp</button>
      <button class="btn" data-act="show">На мапі</button>
      ${blue ? `<a class="btn" href="${esc(blue)}" target="_blank" rel="noopener">BlueMap</a>` : ''}
      <button class="btn danger editor-only" data-act="delete">Видалити</button>
    </div>`;
  $('#schemDrawer').hidden = false;

  const body = $('#drawerBody');
  $('[data-act=tp]', body).onclick = async () => {
    try { await navigator.clipboard.writeText(tp); toast('Скопійовано: ' + tp); }
    catch { toast(tp); }
  };
  $('[data-act=show]', body).onclick = () => {
    showView('map');
    if (state.dim !== s.dimension) setDimension(s.dimension);
    map.setView(toLatLng(s.x, s.z), 2);
  };
  $('[data-act=delete]', body).onclick = async () => {
    if (!confirm(`Видалити «${s.name}»? Файл зникне назавжди.`)) return;
    try {
      await api('schematics/' + s.id, { method: 'DELETE' });
      state.schematics = state.schematics.filter((x) => x.id !== s.id);
      closeDrawer(); renderSchemList(); renderMarkers();
      toast('Схематик видалено');
    } catch (err) { toast(err.message); }
  };

  const box = $('#previewBox');
  if (!['schem', 'litematic'].includes(s.format)) {
    $('.status', box).textContent = 'Прев’ю є лише для .schem і .litematic, але файл можна скачати.';
    return;
  }
  try {
    const [buf, { createViewer }, colors] = await Promise.all([
      fetch(`/api/schematics/${s.id}/file?preview`).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }),
      import('./voxel.js'),
      getBlockColors(),
    ]);
    const parsed = await parseSchematic(buf, s.file_name);
    if (!box.isConnected) return;
    // У подземных построек вокруг сплошная порода: по умолчанию её прячем.
    const toggle = document.createElement('label');
    toggle.className = 'check';
    toggle.innerHTML = '<input type="checkbox"> Сховати породу й руди';
    const cb = $('input', toggle);
    cb.checked = naturalShare(parsed) > 0.4;
    box.after(toggle);
    box.innerHTML = '';
    preview = createViewer(box, { fog: false });
    const draw = () => preview.setModel(parsed, { hideNatural: cb.checked, keepView: true, colors });
    cb.addEventListener('change', draw);
    draw();
  } catch (err) {
    console.error(err);
    if (box.isConnected) box.innerHTML = '<div class="status">Не вдалося побудувати прев’ю, але файл можна скачати.</div>';
  }
}

function openSchemDialog(prefill = {}) {
  const f = $('#schemForm');
  f.reset();
  $('#schemFileInfo').textContent = '.schem, .litematic, .schematic або .nbt, до 25 МБ';
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
    info.textContent = `${fmtSize(file.size)} · ${p.width}×${p.height}×${p.length} блоків`;
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
    toast('Схематик завантажено');
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
  $('[data-title]', f).textContent = task ? (editor ? 'Завдання' : task.title) : 'Нове завдання';
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
  if (!confirm('Видалити завдання?')) return;
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
    await Promise.all([loadLayers(), loadSchematics(), loadTasks(), loadMarkers()]);
    renderCityMap();
    fitCity();
    updateBluemapButton();
    if (store.get('mapMode') === '3d' && currentLayer()?.model) setMode('3d');
    const m = location.hash.match(/^#s=(.+)$/);
    if (m) openSchematic(m[1]);
  } catch (err) {
    toast('Не вдалося завантажити дані: ' + err.message);
  }
})();
