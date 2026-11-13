import { parseSchematic, renderTopDown, naturalShare, suggestSlice } from './schem.js';
import { isAir, isNatural } from './blocks.js';
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
  me: null, // { user, editor, admin } або null для гостя
  schematics: [], tasks: [], layers: [], markers: [],
  dim: 'overworld',
  layerId: store.get('layerId'), // null = первый слой измерения, '' = только сетка
};

document.title = CONFIG.cityName;
$('#brandName').textContent = CONFIG.cityName;

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
  }
  const res = await fetch('/api/' + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Вхід міг закінчитися (вийшов на іншому пристрої, адмін змінив пароль): перевіряємо, хто ми тепер.
    if (res.status === 401 && state.me && !path.startsWith('auth')) refreshMe();
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
const isResident = () => !!state.me?.user;
const ROLE_NAMES = { resident: 'Житель', editor: 'Редактор', admin: 'Адміністратор' };

// ---------- Вхід ----------
// Жителі входять своїм логіном, адміністратор — логіном admin і паролем редактора.
// Без входу видно лише мапу: схематики й завдання сервер віддає тільки жителям.
function setSession(me) {
  const was = state.me?.user?.id;
  state.me = me?.user ? me : null;
  const on = isResident();
  document.body.classList.toggle('resident', on);
  document.body.classList.toggle('editor', !!state.me?.editor);
  document.body.classList.toggle('admin', !!state.me?.admin);
  $('#loginBtn').textContent = on ? state.me.user.username : 'Увійти';
  $('#loginBtn').title = on ? 'Акаунт' : '';
  if (!state.me?.editor) {
    setPlacing(false); stopAreaDraw();
    if ($('#view-stats').classList.contains('active')) showView('map');
  }
  renderPins(); // редактор може перетягувати мітки
  renderMarkersList();
  renderAreas();
  renderMembers(); // кнопка «Мій профіль»
  renderLore();
  return was !== state.me?.user?.id; // чи змінився житель
}
async function refreshMe() {
  const me = await api('auth').catch(() => null);
  if (setSession(me)) await loadPrivate();
}
// Схематики й завдання: після входу підвантажуємо, після виходу ховаємо.
async function loadPrivate() {
  try { await Promise.all([loadSchematics(), loadTasks()]); }
  catch (err) { toast('Не вдалося завантажити дані: ' + err.message); }
}

$('#loginBtn').addEventListener('click', () => (isResident() ? openAccount() : openDialog('#loginDialog')));
$$('[data-login]').forEach((b) => b.addEventListener('click', () => openDialog('#loginDialog')));

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  withBusy(form, async () => {
    const me = await api('auth', { method: 'POST', json: { username: form.username.value, password: form.password.value } });
    setSession(me);
    form.closest('dialog').close();
    form.reset();
    toast(me.admin ? 'Ти увійшов як адміністратор' : `Привіт, ${me.user.username}!`);
    await loadPrivate();
    const m = location.hash.match(/^#s=(.+)$/);
    if (m) openSchematic(m[1]);
  });
});

function openAccount() {
  const d = $('#accountDialog');
  const { user, admin } = state.me;
  $('[data-who]', d).innerHTML = `Ти увійшов як <b>${esc(user.username)}</b> · ${ROLE_NAMES[user.role] || esc(user.role)}`;
  $('#passwordForm').hidden = admin;
  $('#passwordForm').reset();
  $('[data-pass-error]', d).textContent = '';
  openDialog('#accountDialog');
}
$('#logoutBtn').addEventListener('click', async () => {
  await api('auth', { method: 'DELETE' }).catch(() => {});
  $('#accountDialog').close();
  setSession(null);
  await loadPrivate();
  closeDrawer();
  toast('Ти вийшов');
});
$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('[data-pass-error]', f);
  err.textContent = '';
  if (f.password.value !== f.password2.value) { err.textContent = 'Нові паролі не збігаються'; return; }
  try {
    await api('auth/password', { method: 'POST', json: { old: f.old.value, password: f.password.value } });
    f.reset();
    toast('Пароль змінено');
  } catch (x) { err.textContent = x.message; }
});

// Жителі (лише для адміністратора).
let residents = [];
async function openResidents() {
  $('#accountDialog').close();
  const d = openDialog('#residentsDialog');
  $('#residentForm').reset();
  $('#residentsList').innerHTML = '<li class="muted small">Завантаження…</li>';
  try { residents = await api('users'); renderResidents(); }
  catch (err) { $('[data-error]', d).textContent = err.message; }
}
$('#residentsBtn').addEventListener('click', openResidents);
const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('uk-UA') : 'ще не входив');
function renderResidents() {
  $('#residentsCount').textContent = residents.length;
  $('#residentsList').innerHTML = residents.length ? residents.map((u) => `
    <li data-id="${u.id}">
      <div class="res-name"><b>${esc(u.username)}</b><span class="muted small-note">вхід: ${esc(fmtDate(u.last_login))}</span></div>
      <select data-role aria-label="Роль ${esc(u.username)}">
        <option value="resident"${u.role === 'resident' ? ' selected' : ''}>Житель</option>
        <option value="editor"${u.role === 'editor' ? ' selected' : ''}>Редактор</option>
      </select>
      <button type="button" class="btn" data-reset>Новий пароль</button>
      <button type="button" class="btn danger" data-remove aria-label="Видалити ${esc(u.username)}" title="Видалити">×</button>
    </li>`).join('') : '<li class="muted small">Акаунтів ще немає. Додай першого жителя вище.</li>';
}
$('#residentForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    const u = await api('users', { method: 'POST', json: { username: f.username.value, password: f.password.value, role: f.role.value } });
    residents.push(u);
    residents.sort((a, b) => a.username.localeCompare(b.username));
    renderResidents();
    toast(`Акаунт ${u.username} створено. Передай жителю логін і пароль.`);
    f.reset();
  });
});
$('#residentsList').addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-role]');
  if (!sel) return;
  const u = residents.find((r) => r.id === Number(sel.closest('li').dataset.id));
  try {
    Object.assign(u, await api('users/' + u.id, { method: 'PATCH', json: { role: sel.value } }));
    toast(`${u.username}: ${ROLE_NAMES[u.role]}`);
  } catch (err) { sel.value = u.role; toast(err.message); }
});
$('#residentsList').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const u = residents.find((r) => r.id === Number(li.dataset.id));
  try {
    if (e.target.closest('[data-reset]')) {
      const pass = prompt(`Новий пароль для ${u.username} (щонайменше 6 символів). Старий вхід на всіх пристроях закриється.`);
      if (!pass) return;
      await api('users/' + u.id, { method: 'PATCH', json: { password: pass } });
      toast(`Пароль ${u.username} змінено`);
    } else if (e.target.closest('[data-remove]')) {
      if (!confirm(`Видалити акаунт ${u.username}?`)) return;
      await api('users/' + u.id, { method: 'DELETE' });
      residents = residents.filter((r) => r !== u);
      renderResidents();
    }
  } catch (err) { toast(err.message); }
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
  if (name === 'stats' && !isEditor()) name = 'map';
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'map') setTimeout(() => map.invalidateSize(), 0);
  if (name !== 'lore' && !$('#loreDrawer').hidden) closeLoreDrawer();
  if (name === 'stats') loadStats();
  else trackVisit(name === 'map' && v3d.mode === '3d' ? 'map3d' : name);
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
      .bindPopup((layer) => { padPopup(layer.getPopup()); return pinPopup(m); }, { className: 'mark-popup', offset: [0, -10], maxWidth: 300 })
      .on('dragend', (e) => movePin(m, e.target.getLatLng()))
      .on('mouseover', () => pin.getTooltip()?.getElement()?.classList.add('hover'))
      .on('mouseout', () => pin.getTooltip()?.getElement()?.classList.remove('hover'))
      .addTo(pins);
    pinById.set(m.id, pin);
  }
  syncLabels();
}
// Кнопки лежать поверх мапи (на телефоні знизу). Мапа зсувається так, щоб вони не закривали спливашку.
function padPopup(popup) {
  const box = map.getContainer().getBoundingClientRect();
  const bar = $('.map-toolbar').getBoundingClientRect();
  let top = 10, bottom = 10;
  if (bar.height) {
    if (bar.top - box.top < box.height / 2) top = Math.round(bar.bottom - box.top) + 10;
    else bottom = Math.round(box.bottom - bar.top) + 10;
  }
  popup.options.autoPanPaddingTopLeft = L.point(10, top);
  popup.options.autoPanPaddingBottomRight = L.point(10, bottom);
}
// Підписи видно, коли мапа наближена. Здалеку лишаються самі значки, щоб написи не злипались.
function syncLabels() { map.getContainer().classList.toggle('labels-off', map.getZoom() < 1); }
map.on('zoomend', syncLabels);

function pinPopup(m) {
  const k = kindOf(m);
  const imgs = m.images || [];
  const box = document.createElement('div');
  box.className = 'mark-pop' + (imgs.length ? ' has-img' : '');
  box.style.setProperty('--c', k.color);
  // Перша картинка велика, ще до чотирьох дрібно під нею. Решту видно в перегляді на весь екран.
  const more = imgs.length - 5;
  const gallery = imgs.length ? `<div class="mark-pop-imgs">
      <button type="button" class="cover" data-img="0" title="Відкрити картинку"><img src="${imgUrl(m, imgs[0], true)}" alt=""></button>
      ${imgs.length > 1 ? `<div class="strip">${imgs.slice(1, 5).map((im, i) =>
        `<button type="button" data-img="${i + 1}"${i === 3 && more > 0 ? ` data-more="+${more}"` : ''} title="Відкрити картинку"><img src="${imgUrl(m, im, true)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
    </div>` : '';
  box.innerHTML = `${gallery}
    <div class="mark-pop-head">${kindSvg(m.kind)}<b>${esc(m.name)}</b></div>
    <div class="muted small">${k.label} · ${DIM_NAMES[m.dimension]}</div>
    <div class="mono">${fmtXYZ(m)}</div>
    ${m.description ? `<p>${esc(m.description)}</p>` : ''}
    <div class="mark-pop-actions">
      <button type="button" class="btn" data-copy>Копіювати координати</button>
      ${isEditor() ? '<button type="button" class="btn" data-edit>Змінити</button>' : ''}
    </div>`;
  box.addEventListener('click', async (e) => {
    const pic = e.target.closest('[data-img]');
    if (pic) openViewer(markerPics(m), Number(pic.dataset.img), m.name);
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
    ? list.map((m) => `<li><button type="button" data-id="${m.id}" style="--c:${kindOf(m).color}"><span class="mark-ico">${kindSvg(m.kind)}</span><span class="mark-name">${esc(m.name)}</span>${m.images?.length ? `<span class="mark-has-img" title="Картинок: ${m.images.length}">${PIC_SVG}</span>` : '<span></span>'}<span class="mono muted">${m.x} ${m.z}</span></button></li>`).join('')
    : `<li class="muted small">${total ? 'Нічого не знайдено' : 'Міток ще немає. ' + (isEditor() ? 'Натисни «+ Мітка».' : 'Їх ставлять редактори.')}</li>`;
}
$('#markersList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-id]');
  const m = btn && state.markers.find((x) => String(x.id) === btn.dataset.id);
  if (m) flyToMarker(m);
});

function flyToMarker(m) {
  // У 3D камера летить до мітки, якщо вона є в 3D; інакше показуємо її на 2D-мапі.
  if (v3d.mode === '3d' && v3d.viewer?.focus('m' + m.id)) {
    if (window.matchMedia('(max-width: 760px)').matches) toggleMarkersPanel(false);
    return;
  }
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
  resetPics(m);
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
    await picEdit.preparing; // картинки, які ще стискаються, теж мають потрапити в мітку
    const saved = form.dataset.id
      ? await api('markers/' + form.dataset.id, { method: 'PATCH', json: body })
      : await api('markers', { method: 'POST', json: body });
    // Далі мітка вже є: якщо картинка не завантажиться, повторне «Зберегти» не створить другу таку саму.
    form.dataset.id = saved.id;
    picEdit.marker = saved;
    try {
      await syncPics(saved.id, form);
    } catch (err) {
      $('[data-title]', form).textContent = 'Мітка';
      $('[data-delete]', form).hidden = false;
      await loadMarkers().catch(() => {});
      throw new Error(`Мітку збережено, але картинки — ні: ${err.message}. Натисни «Зберегти» ще раз.`);
    }
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

// --- Картинки міток ---
// Сайт сам зменшує картинку до 1920 px (WebP, а де його немає — JPEG) і робить мініатюру для спливашки,
// тож скріншот на кілька мегабайт важить кількасот КБ. Нові картинки завантажуються після «Зберегти».
const PIC_MAX = 1920, PIC_THUMB = 480, PIC_LIMIT = 12;
const PIC_KEEP = 600 * 1024; // невелику картинку потрібного розміру не перестискаємо
const PIC_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1 3h14v10H1zm2 2v6h10V5zm1 5 3-3 2 2 1-1 2 2z"/></svg>';
const imgUrl = (m, im, thumb) => `/api/markers/${m.id}/images/${im.id}${thumb ? '?t' : ''}`;
const markerPics = (m) => (m.images || []).map((im) => ({ full: imgUrl(m, im), thumb: imgUrl(m, im, true) }));
const picEdit = { marker: null, items: [], preparing: Promise.resolve(), gen: 0 };

async function encodePic(bmp, max, quality) {
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  const toBlob = (type, q) => new Promise((done) => c.toBlob(done, type, q));
  let blob = await toBlob('image/webp', quality);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', quality); // старий Safari не вміє WebP
  if (!blob) throw new Error('браузер не зміг стиснути картинку');
  return { blob, w, h };
}

async function preparePic(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch {
    throw new Error(`не вдалося відкрити «${file.name || 'картинку'}». Підійдуть PNG, JPG або WebP`);
  }
  try {
    const side = Math.max(bmp.width, bmp.height);
    const keep = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) && file.size <= PIC_KEEP && side <= PIC_MAX;
    let big = keep ? { blob: file, w: bmp.width, h: bmp.height } : await encodePic(bmp, PIC_MAX, 0.86);
    if (big.blob.size > 2.8 * 1024 * 1024) big = await encodePic(bmp, PIC_MAX, 0.7);
    const thumb = side > PIC_THUMB ? (await encodePic(bmp, PIC_THUMB, 0.8)).blob : null;
    return { ...big, thumb };
  } finally { bmp.close?.(); }
}

function resetPics(m) {
  for (const it of picEdit.items) if (it.local) { URL.revokeObjectURL(it.url); URL.revokeObjectURL(it.full); }
  picEdit.gen++; // картинка, що ще стискалася для попередньої мітки, сюди вже не потрапить
  picEdit.marker = m || null;
  picEdit.items = (m?.images || []).map((im) => ({ im }));
  renderPics();
}
$('#markerDialog').addEventListener('close', () => resetPics(null));

const shownPics = () => picEdit.items.filter((it) => !it.removed);
function renderPics() {
  const f = $('#markerForm');
  const editor = isEditor();
  const shown = shownPics();
  $('[data-imgs]', f).hidden = !editor && !shown.length;
  $('[data-img-add]', f).hidden = !editor || shown.length >= PIC_LIMIT;
  const changed = picEdit.items.some((it) => it.local || it.removed);
  const hint = $('[data-img-hint]', f);
  hint.hidden = !editor;
  hint.textContent = changed ? 'Зміни в картинках збережуться, коли натиснеш «Зберегти».'
    : shown.length >= PIC_LIMIT ? `Більше ${PIC_LIMIT} картинок до однієї мітки додати не можна.`
    : 'Скріншот можна вставити з буфера (Ctrl+V) або перетягнути у це вікно.';
  $('[data-thumbs]', f).innerHTML = shown.map((it, i) => `
    <li class="${it.local ? 'new' : ''}">
      <button type="button" class="thumb" data-view="${i}" title="Відкрити"><img src="${esc(it.local ? it.url : imgUrl(picEdit.marker, it.im, true))}" alt=""></button>
      ${editor ? `<button type="button" class="thumb-x" data-drop="${i}" aria-label="Прибрати картинку" title="Прибрати">×</button>` : ''}
      ${it.local ? '<span class="thumb-tag">нова</span>' : ''}
    </li>`).join('');
}

function queuePics(files) {
  const f = $('#markerForm');
  const list = [...files].filter((x) => x?.type?.startsWith('image/'));
  if (!list.length) { showError(f, 'Тут можна додати лише картинки: PNG, JPG або WebP'); return; }
  const gen = picEdit.gen;
  picEdit.preparing = picEdit.preparing.then(async () => {
    const room = PIC_LIMIT - shownPics().length;
    if (gen !== picEdit.gen) return;
    showError(f, list.length > room ? `До мітки можна додати до ${PIC_LIMIT} картинок, зайві пропущено` : '');
    for (const file of list.slice(0, Math.max(0, room))) {
      try {
        const p = await preparePic(file);
        if (gen !== picEdit.gen) return;
        picEdit.items.push({ local: true, ...p, url: URL.createObjectURL(p.thumb || p.blob), full: URL.createObjectURL(p.blob) });
        renderPics();
      } catch (err) { showError(f, 'Картинку не додано: ' + err.message); }
    }
  });
}

// Застосовує зміни в картинках до збереженої мітки: спершу прибирає видалені, потім завантажує нові.
async function syncPics(markerId, form) {
  const btn = $('button.primary', form);
  const label = btn.textContent;
  const items = picEdit.items;
  const adds = items.filter((it) => it.local);
  try {
    for (const it of items.filter((x) => x.removed)) {
      await api(`markers/${markerId}/images/${it.im.id}`, { method: 'DELETE' });
      items.splice(items.indexOf(it), 1);
    }
    for (const [n, it] of adds.entries()) {
      btn.textContent = adds.length > 1 ? `Завантаження ${n + 1}/${adds.length}…` : 'Завантаження…';
      const fd = new FormData();
      const ext = (b) => b.type.split('/')[1].replace('jpeg', 'jpg');
      fd.append('image', it.blob, 'image.' + ext(it.blob));
      if (it.thumb) fd.append('thumb', it.thumb, 'thumb.' + ext(it.thumb));
      fd.append('width', it.w);
      fd.append('height', it.h);
      const res = await api(`markers/${markerId}/images`, { method: 'POST', body: fd });
      URL.revokeObjectURL(it.url); URL.revokeObjectURL(it.full);
      items[items.indexOf(it)] = { im: res.image };
      picEdit.marker = res;
    }
  } finally {
    btn.textContent = label;
    renderPics();
  }
}

{
  const f = $('#markerForm');
  const dlg = $('#markerDialog');
  const file = $('[data-img-file]', f);
  $('[data-img-add]', f).addEventListener('click', () => file.click());
  file.addEventListener('change', () => { if (file.files.length) queuePics(file.files); file.value = ''; });
  $('[data-thumbs]', f).addEventListener('click', (e) => {
    const shown = shownPics();
    const drop = e.target.closest('[data-drop]');
    if (drop) {
      const it = shown[Number(drop.dataset.drop)];
      if (it.local) {
        URL.revokeObjectURL(it.url); URL.revokeObjectURL(it.full);
        picEdit.items.splice(picEdit.items.indexOf(it), 1);
      } else it.removed = true;
      renderPics();
      return;
    }
    const view = e.target.closest('[data-view]');
    if (view) {
      const pics = shown.map((it) => it.local ? { full: it.full, thumb: it.url }
        : { full: imgUrl(picEdit.marker, it.im), thumb: imgUrl(picEdit.marker, it.im, true) });
      openViewer(pics, Number(view.dataset.view), f.name.value || 'Нова мітка');
    }
  });
  // Скріншот з буфера (Ctrl+V) або перетягнутий файл одразу стає картинкою мітки.
  dlg.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((x) => x.type.startsWith('image/'));
    if (!isEditor() || !files.length) return; // звичайний текст вставляється як завжди
    e.preventDefault();
    queuePics(files);
  });
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  dlg.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isEditor() ? 'copy' : 'none';
    if (isEditor()) dlg.classList.add('dropping');
  });
  dlg.addEventListener('dragleave', (e) => { if (!dlg.contains(e.relatedTarget)) dlg.classList.remove('dropping'); });
  dlg.addEventListener('drop', (e) => {
    dlg.classList.remove('dropping');
    if (!hasFiles(e)) return;
    e.preventDefault(); // інакше браузер відкриє файл замість сайту
    if (isEditor()) queuePics(e.dataTransfer.files);
  });
}

// Перегляд на весь екран: стрілки ← →, свайп на телефоні, Esc закриває.
const viewer = { pics: [], i: 0 };
function openViewer(pics, i, title) {
  if (!pics.length) return;
  const d = $('#imgViewer');
  viewer.pics = pics;
  $('[data-caption]', d).textContent = title || '';
  $('[data-prev]', d).hidden = $('[data-next]', d).hidden = pics.length < 2;
  showPic(i);
  if (!d.open) d.showModal();
}
function showPic(i) {
  const d = $('#imgViewer');
  const n = viewer.pics.length;
  viewer.i = ((i % n) + n) % n;
  const pic = viewer.pics[viewer.i];
  const img = $('[data-img]', d);
  // Поки вантажиться велика картинка, видно мініатюру, яка вже є в кеші.
  img.src = pic.thumb;
  const full = new Image();
  full.onload = () => { if (viewer.pics[viewer.i] === pic) img.src = pic.full; };
  full.src = pic.full;
  $('[data-count]', d).textContent = n > 1 ? `${viewer.i + 1} / ${n}` : '';
  $('[data-open]', d).href = pic.full;
}
{
  const d = $('#imgViewer');
  $('[data-prev]', d).addEventListener('click', () => showPic(viewer.i - 1));
  $('[data-next]', d).addEventListener('click', () => showPic(viewer.i + 1));
  d.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); showPic(viewer.i - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); showPic(viewer.i + 1); }
  });
  let startX = null;
  const stage = $('[data-stage]', d);
  stage.addEventListener('pointerdown', (e) => { startX = e.clientX; });
  stage.addEventListener('pointerup', (e) => {
    const dx = startX === null ? 0 : e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40 && viewer.pics.length > 1) showPic(viewer.i + (dx < 0 ? 1 : -1));
  });
  d.addEventListener('close', () => { $('[data-img]', d).removeAttribute('src'); viewer.pics = []; });
}

// ---------- Жива мапа ----------
// Мод у грі малює чанки, які прогрузив гравець, і надсилає їх на сайт. Тут вони лягають поверх мапи:
// здалеку мініатюри 16×16 (піксель на блок), зблизька картинки 256×256 (16 пікселів на блок, як у грі).
const live = {
  layerId: null, epoch: null, since: 0, busy: false, polledAt: 0,
  loaded: false, // список чанків цієї епохи вже прочитано
  fastUntil: 0, // до цього часу питаємо про нові чанки частіше
  tiles: new Map(), // 'cx,cz' → { hash, at, player }
  minis: new Map(), // 'cx,cz' → 1024 байти RGBA
  imgs: new Map(), // 'cx,cz' → <img> на мапі
  blocks: new Map(), // огляд здалеку: 'bx,bz' → { overlay, url }, квадрат 32×32 чанки
  gen: 0,
};
const OV = 32;
const FAST_MS = 3 * 60_000;
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
// У 3D він теж лишається ввімкненим: вікно «Жива мапа» показує правду, а чанки з гри вже чекають у 2D.
function syncLive() {
  const layer = currentLayer();
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
  live.loaded = false;
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
        // Чанки стерли або змінили зріз: починаємо спочатку, а мод скоро намалює їх заново.
        resetLive(data.live?.epoch ?? null);
        live.fastUntil = Date.now() + FAST_MS;
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
      const first = !live.loaded;
      live.loaded = true;
      if (first || changed.length) renderAreas(); // ярлики областей показують, скільки чанків ще чекають
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
// Зазвичай сайт питає про нові чанки раз на хвилину. Після зміни зрізу чи області мод
// перемальовує стерті чанки, тож кілька хвилин (FAST_MS) питаємо кожні 10 секунд, щоб вони з’явились одразу.
setInterval(() => {
  if (document.hidden) return;
  const every = Date.now() < live.fastUntil ? 10_000 : 60_000;
  if (Date.now() - live.polledAt >= every) pollLive();
}, 2000);
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
      : `Шар «${esc(layer.name)}» чекає на перші чанки з гри. Зріз: Y від ${layer.live.top} до ${layer.live.bottom}.`) + areas
      + (v3d.mode === '3d' ? ' У 3D місто збудоване зі схематика, а свіжі чанки з гри видно на 2D-мапі.' : '');
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
    live.fastUntil = Date.now() + FAST_MS;
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
  const counted = live.loaded && live.layerId === layer.id;
  for (const a of layer.liveAreas || []) {
    const own = a.top !== layer.live.top || a.bottom !== layer.live.bottom;
    const rect = L.rectangle(areaBounds(a), { ...AREA_STYLE, interactive: false, className: 'live-area' + (own ? ' own' : '') });
    rect.areaId = a.id;
    rect.addTo(areaShapes);
    // Чанки без картинки з гри: щойно стерті після зміни зрізу або ще не відвідані.
    const missing = counted ? areaMissing(a) : 0;
    const wait = missing
      ? ` <span class="area-wait">${missing} ${chunksWord(missing)} ${missing % 10 === 1 && missing % 100 !== 11 ? 'чекає' : 'чекають'} на мод</span>`
      : '';
    const title = missing ? 'Змінити область. Чанки без картинки мод намалює, коли поруч буде гравець із модом.' : 'Змінити область';
    const icon = L.divIcon({
      className: '', iconSize: null, iconAnchor: [0, 0],
      html: `<span class="area-tag${own ? ' own' : ''}" title="${title}">${esc(areaName(layer, a))} <span class="mono">Y ${a.top}…${a.bottom}</span>${wait}</span>`,
    });
    L.marker(toLatLng(a.minX, a.minZ), { icon, zIndexOffset: -200, title: areaName(layer, a) })
      .on('click', () => { if (!draw.layer && !placing) openArea(layer, a); })
      .addTo(areaShapes);
  }
}
function areaMissing(a) {
  let n = 0;
  for (let cz = Math.floor(a.minZ / 16); cz <= Math.floor(a.maxZ / 16); cz++) {
    for (let cx = Math.floor(a.minX / 16); cx <= Math.floor(a.maxX / 16); cx++) {
      if (!live.tiles.has(liveKey(cx, cz))) n++;
    }
  }
  return n;
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
  if (r.erased) {
    live.layerId = null; // чанки стерлися: перечитуємо живий шар з нуля
    live.fastUntil = Date.now() + FAST_MS;
  }
  renderCityMap();
  const text = saved + (r.erased
    ? ` Стерто старих чанків: ${r.erased}. Мод намалює їх заново, коли поруч буде гравець із модом, а доти там видно стару мапу.`
    : '');
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

// ---------- Текстури з гри (для 3D і мапи зі схематика) ----------
// .jar гри або ресурспак читається лише в цьому браузері й запам’ятовується в його IndexedDB, щоб
// наступного разу не вибирати знову. На сайт файл не йде: текстури Mojang викладати не можна.
const loadTextures = () => import('./textures.js');
const packs = { files: null, assets: null, opening: null, baked: new WeakMap() };
const packName = () => (packs.assets?.version ? `Minecraft ${packs.assets.version}` : (packs.files || []).map((f) => f.name).join(', '));

// Файли гри, вибрані зараз або запам’ятані раніше; null, якщо їх немає.
function getPacks() {
  if (packs.assets) return Promise.resolve(packs.assets);
  packs.opening ??= (async () => {
    const tx = await loadTextures();
    const files = await tx.rememberedPacks();
    if (!files?.length) return null;
    try {
      const assets = await tx.openPacks(files);
      if (!packs.assets) { packs.assets = assets; packs.files = files; }
      return packs.assets;
    } catch (e) {
      console.warn('Запам’ятані файли гри не відкрились:', e);
      tx.forgetPacks();
      return null;
    }
  })().finally(() => { packs.opening = null; });
  return packs.opening;
}
async function usePacks(files) {
  const tx = await loadTextures();
  const assets = await tx.openPacks(files); // кидає зрозумілу помилку, якщо це не файл гри
  Object.assign(packs, { assets, files, baked: new WeakMap() });
  tx.rememberPacks(files);
  return assets;
}
async function dropPacks() {
  const tx = await loadTextures();
  await tx.forgetPacks();
  Object.assign(packs, { assets: null, files: null, baked: new WeakMap() });
}
// Архів лише з текстурами (textures.zip): теж лишається тільки в цьому браузері. Моделей у ньому немає,
// тож він замінює відкритий ресурспак у «піксельному» 3D. null — беремо відкритий пак із сайту.
// site: зараз 3D малюється текстурами, які редактор поклав на сайт для всіх.
const texZip = { tiles: null, name: '', opening: null, site: false };
function getTexZip() {
  if (texZip.tiles) return Promise.resolve(texZip.tiles);
  texZip.opening ??= (async () => {
    try {
      const tx = await loadTextures();
      const files = await tx.rememberedPacks('texzip');
      if (!files?.length) return null;
      const tiles = await tx.openTextureZip(files);
      if (tiles && !texZip.tiles) Object.assign(texZip, { tiles, name: files[0].name });
      return texZip.tiles;
    } catch (e) {
      console.warn('Запам’ятаний архів текстур не відкрився:', e);
      return null;
    }
  })();
  return texZip.opening;
}
// Текстури для 3D без моделей гри: свій архів, якщо вибрано, інакше відкритий пак.
async function pixelKit() {
  const m = await import('./pixels.js');
  const site = (await getTexZip()) ? null : await m.loadSitePack();
  texZip.site = !!site;
  return { pixelBlocks: m.pixelBlocks, pack: (await getTexZip()) || site || (await m.loadOpenPack()) };
}
// Моделі блоків схематика з текстурами: збираються раз на схематик і набір файлів.
function bakedFor(schem, onProgress) {
  const assets = packs.assets;
  if (!assets) return Promise.resolve(null);
  let job = packs.baked.get(schem);
  if (!job || job.assets !== assets) {
    job = { assets, promise: loadTextures().then((tx) => tx.bakeBlocks(assets, schem.states, onProgress)) };
    packs.baked.set(schem, job);
    job.promise.catch(() => packs.baked.delete(schem));
  }
  return job.promise;
}

// ---------- 3D-режим ----------
// Слой, нарисованный из схематика, хранит сам схематик, и город можно покрутить в 3D.
const v3d = { mode: '2d', viewer: null, key: null, schem: null, layer: null, baked: null, bakedWith: null };
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
  if ($('#view-map').classList.contains('active')) trackVisit(mode === '3d' ? 'map3d' : 'map');
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
      const [{ createViewer }, { pixelBlocks, pack }, buf, colors] = await Promise.all([
        import('./voxel.js'),
        pixelKit(),
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
      v3d.baked = v3d.bakedWith = null; // моделі блоків належать попередньому схематику
      // Без файлу гри блоки однаково піксельні: сайт малює їм схожі на гру текстури сам.
      v3d.pixels = pixelBlocks(schem.states || schem.palette, colors, pack);
      // Що гравці збудували після схематика: блоки чанків, які надіслав мод.
      v3d.blocksSince = 0;
      await syncBlocks3d(key, true);
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
    texture3d();
  } catch (err) {
    console.error(err);
    v3dStatus('Не вдалося відкрити 3D: ' + err.message);
  }
}

// ---------- 3D оновлюється від мода ----------
// Мод надсилає блоки чанків у межах моделі (gzip: i16 minY, u16 висота, u16 розмір палітри, стани блоків,
// далі номери в палітрі в порядку x + z*16 + y*256). Вставляємо їх у схематик поверх того, що було у файлі.
async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
// Повертає, скільки блоків схематика змінилося.
function applyChunkBlocks(schem, layer, cx, cz, raw) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const minY = dv.getInt16(0), h = dv.getUint16(2), count = dv.getUint16(4);
  const dec = new TextDecoder();
  let o = 6;
  schem.states ||= schem.palette.slice();
  schem.stateIndex ||= new Map(schem.states.map((st, i) => [st, i]));
  const ids = new Array(count);
  for (let i = 0; i < count; i++) {
    const n = dv.getUint16(o);
    const st = dec.decode(raw.subarray(o + 2, o + 2 + n));
    o += 2 + n;
    let id = schem.stateIndex.get(st);
    if (id === undefined) {
      if (schem.states.length >= 65535) { ids[i] = -1; continue; }
      id = schem.states.length;
      schem.states.push(st);
      schem.palette.push(st.replace(/\[.*$/, ''));
      schem.stateIndex.set(st, id);
    }
    ids[i] = id;
  }
  const wide = count > 256;
  if (raw.length < o + h * 256 * (wide ? 2 : 1)) throw new Error('обрізані блоки чанка');
  const { width: W, height: H, length: L, blocks } = schem;
  const x0 = cx * 16 - layer.originX, z0 = cz * 16 - layer.originZ, y0 = minY - layer.model.minY;
  let changed = 0;
  for (let ly = 0; ly < h; ly++) {
    const y = y0 + ly;
    if (y < 0 || y >= H) continue;
    for (let lz = 0; lz < 16; lz++) {
      const z = z0 + lz;
      if (z < 0 || z >= L) continue;
      for (let lx = 0; lx < 16; lx++) {
        const x = x0 + lx;
        if (x < 0 || x >= W) continue;
        const k = o + (lx + lz * 16 + ly * 256) * (wide ? 2 : 1);
        const id = ids[wide ? dv.getUint16(k) : raw[k]];
        const i = x + z * W + y * W * L;
        if (id >= 0 && blocks[i] !== id) { blocks[i] = id; changed++; }
      }
    }
  }
  return changed;
}
// Забирає з сайту блоки чанків, змінені після v3d.blocksSince. first — перше завантаження (місто ще не збудоване).
async function syncBlocks3d(key, first) {
  const layer = v3d.layer, schem = v3d.schem;
  if (!layer?.live || !schem || v3d.blocksBusy) return;
  v3d.blocksBusy = true;
  try {
    let changed = 0, since = v3d.blocksSince, offset = 0;
    for (;;) {
      const r = await fetch(`/api/live/${encodeURIComponent(layer.id)}/blocks?since=${v3d.blocksSince}&offset=${offset}`);
      if (!r.ok) break;
      const buf = new Uint8Array(await r.arrayBuffer());
      const dv = new DataView(buf.buffer);
      let o = 0, n = 0;
      while (o + 20 <= buf.length) {
        const cx = dv.getInt32(o), cz = dv.getInt32(o + 4), at = dv.getFloat64(o + 8), len = dv.getUint32(o + 16);
        try {
          const raw = await gunzipBytes(buf.subarray(o + 20, o + 20 + len));
          if (v3d.key !== key) return;
          changed += applyChunkBlocks(schem, layer, cx, cz, raw);
        } catch (e) { console.warn('Блоки чанка', cx, cz, e); }
        since = Math.max(since, at + 1);
        o += 20 + len;
        n++;
      }
      offset += n;
      if (r.headers.get('x-more') !== '1' || !n) break;
    }
    v3d.blocksSince = since;
    if (!changed || v3d.key !== key) return;
    // Блоки змінилися: текстури й моделі блоків рахуємо заново (могли з’явитися нові стани).
    const kit = await pixelKit();
    v3d.pixels = kit.pixelBlocks(schem.states, v3d.colors, kit.pack);
    packs.baked.delete(schem);
    v3d.baked = v3d.bakedWith = null;
    if (!first) { build3d(true); markers3d(); texture3d(); }
  } catch (e) {
    console.warn('3D: блоки з мода не завантажились', e);
  } finally {
    v3d.blocksBusy = false;
  }
}
// Поки відкрито 3D, раз на хвилину питаємо, чи не збудували щось нове.
setInterval(() => {
  if (v3d.mode === '3d' && v3d.key && !document.hidden) syncBlocks3d(v3d.key, false);
}, 60_000);

function build3d(keepView) {
  const model = v3d.viewer.setModel(v3d.schem, {
    hideNatural: $('#v3dRock').checked, keepView, colors: v3d.colors, baked: v3d.baked || v3d.pixels,
  });
  if (v3d.baked && !model.textured && !v3d.warned) {
    v3d.warned = true;
    toast('Ця відеокарта не тягне текстури в 3D, тому місто кольорове');
  }
  applyClip();
}

// Текстури в 3D: якщо в цьому браузері є файли гри, місто перебудовується за справжніми моделями блоків.
async function texture3d() {
  const key = v3d.key, schem = v3d.schem;
  if (!schem) return;
  const assets = await getPacks();
  renderTexInfo();
  if (v3d.key !== key) return;
  if (!assets) {
    if (v3d.baked) { v3d.baked = v3d.bakedWith = null; build3d(true); }
    return;
  }
  if (v3d.baked && v3d.bakedWith === assets) return; // уже з цими текстурами
  try {
    const baked = await bakedFor(schem, (done, total) => {
      if (v3d.key === key) v3dStatus(`Накладаю текстури з гри: ${done} з ${total}…`);
    });
    if (v3d.key !== key || packs.assets !== assets) return;
    v3dStatus('Будую місто з текстурами…');
    await new Promise((r) => setTimeout(r, 30));
    Object.assign(v3d, { baked, bakedWith: assets });
    build3d(true);
  } catch (err) {
    console.error(err);
    toast('Не вдалося накласти текстури: ' + err.message);
  } finally {
    if (v3d.key === key) v3dStatus('');
  }
}

function renderTexInfo() {
  const on = !!packs.assets || !!texZip.tiles;
  $('#v3dTexBtn').textContent = on ? 'Прибрати текстури' : 'Текстури з гри';
  $('.v3d-credit').hidden = on || texZip.site; // з файлом гри текстури вже не з паку
  $('#v3dPackDel').hidden = !texZip.site;
  $('#v3dTexInfo').innerHTML = packs.assets
    ? `Текстури: ${esc(packName())}. Файл запам’ятано лише в цьому браузері, на сайт він не йде.`
    : texZip.tiles ? `Текстури: ${esc(texZip.name)}. Архів запам’ятано лише в цьому браузері, на сайт він не йде.`
    : texZip.site ? 'Текстури гри, які редактор поклав на сайт для всіх. Для справжніх моделей блоків вибери на комп’ютері файл гри (.jar).'
    : 'Зараз текстури з відкритого ресурспаку <a href="/pack/CREDITS.txt" target="_blank" rel="noopener">Pixel Perfection</a>. Для справжніх текстур і моделей вибери на комп’ютері файл гри: <span class="mono">%APPDATA%\\.minecraft\\versions\\26.3\\26.3.jar</span>, а на телефоні — архів <span class="mono">textures.zip</span> із текстурами гри. Він читається лише в цьому браузері й нікуди не завантажується.';
}
renderTexInfo();
// Перемалювати 3D «піксельним» шляхом із поточними текстурами (свій архів або відкритий пак).
async function repixel3d() {
  if (!v3d.schem) return;
  const kit = await pixelKit();
  v3d.pixels = kit.pixelBlocks(v3d.schem.states || v3d.schem.palette, v3d.colors, kit.pack);
  if (!v3d.baked) build3d(true);
}
$('#v3dTexBtn').addEventListener('click', async () => {
  if (!packs.assets && !texZip.tiles) { $('#v3dTexFile').click(); return; }
  if (texZip.tiles) {
    (await loadTextures()).forgetPacks('texzip');
    Object.assign(texZip, { tiles: null, name: '', opening: null });
    await repixel3d();
    if (!packs.assets) { renderTexInfo(); toast('Текстури прибрано, архів забуто'); return; }
  }
  await dropPacks();
  Object.assign(fromSchem, { assets: null, texName: '', tiles: null }); // і «Мапа зі схематика» без них
  v3d.baked = v3d.bakedWith = null;
  if (v3d.schem) build3d(true);
  renderTexInfo();
  toast('Текстури прибрано, файл гри забуто');
});
$('#v3dPackDel').addEventListener('click', async () => {
  if (!confirm('Прибрати текстури гри з сайту? 3D у всіх повернеться до відкритого ресурспаку.')) return;
  try {
    await api('pack', { method: 'DELETE' });
    (await import('./pixels.js')).resetSitePack();
    await repixel3d();
    renderTexInfo();
    toast('Текстури з сайту прибрано');
  } catch (err) { toast(err.message); }
});
$('#v3dTexFile').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  v3dStatus('Відкриваю файл гри…');
  try {
    // Архів лише з текстурами: без моделей, тож іде «піксельним» шляхом.
    const tx = await loadTextures();
    const tiles = await tx.openTextureZip(files, (i, n) => v3dStatus(`Читаю текстури: ${i} з ${n}…`));
    if (tiles && isEditor() && confirm(`Показувати ці текстури (${tiles.size}) у 3D усім відвідувачам сайту?\n\nЯк у BlueMap: текстури з твоєї гри роздаватиме сайт. Відповідальність за це перед Mojang на власникові сайту. «Скасувати» — лишити їх тільки в цьому браузері.`)) {
      v3dStatus('Кладу текстури на сайт…');
      const px = await import('./pixels.js');
      const { blob, meta } = await px.buildSheet(tiles);
      const fd = new FormData();
      fd.set('image', blob, 'blocks.png');
      fd.set('meta', JSON.stringify(meta));
      fd.set('name', files[0].name);
      await api('pack', { method: 'POST', body: fd });
      px.resetSitePack();
      await repixel3d();
      renderTexInfo();
      v3dStatus('');
      toast(`Текстури на сайті: ${tiles.size}. Тепер 3D у всіх із ними`);
      return;
    }
    if (tiles) {
      Object.assign(texZip, { tiles, name: files[0].name, opening: null });
      tx.rememberPacks(files, 'texzip');
      await repixel3d();
      renderTexInfo();
      v3dStatus('');
      toast(`Текстури з ${files[0].name}: ${tiles.size}. Архів лишається лише в цьому браузері`);
      return;
    }
    await usePacks(files);
    Object.assign(fromSchem, { assets: null, texName: '', tiles: null }); // діалог мапи візьме новий файл
  } catch (err) {
    v3dStatus('');
    toast('Не вдалося прочитати файл: ' + err.message);
    return;
  }
  v3dStatus('');
  await texture3d();
});
function applyClip() {
  const clip = $('#v3dClip');
  const y = Number(clip.value);
  $('#v3dClipVal').textContent = y >= Number(clip.max) ? 'усе місто' : 'Y ' + y;
  if (v3d.viewer && v3d.layer?.model) {
    v3d.viewer.setClip(y - v3d.layer.model.minY + 1);
    standMarkers();
  }
}
$('#v3dClip').addEventListener('input', applyClip);
$('#v3dRock').addEventListener('change', () => {
  if (!v3d.schem) return;
  v3dStatus('Перебудовую…');
  setTimeout(() => { build3d(true); v3dStatus(''); }, 30);
});

// Мітки в 3D. Мітка без Y (або з Y поза моделлю) стоїть на верхньому видимому блоці свого стовпця
// в межах зрізу, з яким видно 2D-мапу, і не вище повзунка висоти: там само, де її видно на 2D.
const MARK_PAD = 64; // мітки трохи за межами схематика теж показуємо
// Верх зрізу в цьому стовпці, як у мода: найменша область, що його містить (при рівних — пізніша), інакше шар.
function sliceTopAt(layer, wx, wz) {
  let best = null, bestSize = Infinity;
  for (const r of (layer.live && layer.liveAreas) || []) {
    if (wx < r.minX || wx > r.maxX || wz < r.minZ || wz > r.maxZ) continue;
    const size = (r.maxX - r.minX + 1) * (r.maxZ - r.minZ + 1);
    if (size <= bestSize) { best = r; bestSize = size; }
  }
  return best?.top ?? layer.live?.top ?? layer.model.sliceTop;
}
function standY(layer, wx, wz) {
  const { width: W, height: H, length: L, blocks, palette } = v3d.schem;
  const minY = layer.model.minY;
  const x = Math.min(W - 1, Math.max(0, Math.floor(wx - layer.originX)));
  const z = Math.min(L - 1, Math.max(0, Math.floor(wz - layer.originZ)));
  const top = sliceTopAt(layer, wx, wz);
  const clip = Number($('#v3dClip').value);
  const start = Math.max(0, Math.min(H - 1,
    Number.isFinite(clip) ? clip - minY : H - 1, Number.isFinite(top) ? top - minY : H - 1));
  const hide = $('#v3dRock').checked;
  for (let y = start; y >= 0; y--) {
    const n = palette[blocks[x + z * W + y * W * L]];
    if (!isAir(n) && !(hide && isNatural(n))) return y + 1;
  }
  return start; // у стовпці нічого не видно: мітка висить на рівні зрізу
}
// Мітки без Y опускаються за повзунком висоти й за прихованою породою.
function standMarkers() {
  const layer = v3d.layer;
  if (!v3d.viewer || !v3d.schem || !layer?.model) return;
  v3d.viewer.moveMarkers((m) => m.stand && standY(layer, m.stand[0], m.stand[1]));
}

function markers3d() {
  const layer = v3d.layer;
  if (!v3d.viewer || !layer?.model || !v3d.schem) return;
  const { width: W, height: H, length: L } = v3d.schem;
  const near = (o) => o.x >= layer.originX - MARK_PAD && o.z >= layer.originZ - MARK_PAD
    && o.x < layer.originX + W + MARK_PAD && o.z < layer.originZ + L + MARK_PAD;
  const place = (o, m) => {
    const y = o.y == null ? null : o.y - layer.model.minY;
    const fits = y !== null && y > -16 && y < H + 16;
    return {
      ...m, x: o.x - layer.originX, z: o.z - layer.originZ,
      y: fits ? y : standY(layer, o.x, o.z),
      stand: fits ? null : [o.x, o.z],
      label: fits || y === null ? m.label : `${m.label} · Y ${o.y}`, // справжня висота далеко від міста
    };
  };
  const center = CONFIG.center && layer.dimension === 'overworld' && near(CONFIG.center) ? CONFIG.center : null;
  const list = [
    ...(center ? [place(center, { id: 'c', label: 'Центр міста' })] : []),
    ...state.schematics.filter((s) => s.dimension === layer.dimension && near(s))
      .map((s) => place(s, { id: 's' + s.id, label: s.name })),
    ...state.markers.filter((m) => m.dimension === layer.dimension && near(m))
      .map((m) => place(m, { id: 'm' + m.id, label: m.name, color: kindOf(m).color })),
  ];
  v3d.viewer.setMarkers(list, (id) => {
    if (id === 'c') return toast(`Центр міста: X ${center.x} · Y ${center.y} · Z ${center.z}`);
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
  if (!layer) return;
  const lost = [];
  if (layer.model) lost.push('3D-модель');
  if (layer.live) {
    const n = await api(`live/${encodeURIComponent(layer.id)}?since=0`).then((d) => d.tiles.length).catch(() => 0);
    if (n) lost.push(`${n} ${chunksWord(n)} з гри`);
  }
  const areas = (layer.liveAreas || []).length;
  if (areas) lost.push(`${areas} ${areasWord(areas)}`);
  const warn = lost.length ? `\n\nРазом із ним зникнуть ${lost.join(', ')}. Щоб перемалювати мапу, шар не треба видаляти: вибери його в «Мапа зі схематика».` : '';
  if (!confirm(`Видалити шар «${layer.name}»?${warn}`)) return;
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
  else {
    $('[data-tex-info]', f).innerHTML = TEX_HINT;
    // Файл гри, вибраний раніше (тут або в 3D), запам’ятано в цьому браузері: беремо його.
    getPacks().then((assets) => {
      if (!assets || fromSchem.assets || !$('#fromSchemDialog').open) return;
      fromSchem.assets = assets;
      fromSchem.texName = packName();
      $('[data-tex-info]', f).textContent = `Текстури: ${fromSchem.texName} (запам’ятано в цьому браузері). Можна вибрати інший файл.`;
      prepareTiles(f);
    });
  }
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
    let saved = null;
    try { saved = JSON.parse(store.get('schemCorner:' + file.name) || 'null'); } catch { /* немає */ }
    if (saved && f.minX.value === '' && f.minZ.value === '') {
      f.minX.value = saved.minX;
      f.minY.value = saved.minY;
      f.minZ.value = saved.minZ;
    }
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
    fromSchem.assets = await usePacks(files);
    fromSchem.texName = packName();
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
    const twin = !form.layerId.value && state.layers.find((l) => l.name === (form.name.value || 'Підземне місто') && l.dimension === form.dimension.value);
    if (twin && !confirm(`Шар «${twin.name}» уже є. Створити ще один такий самий?\n\nЩоб перемалювати наявний і зберегти його області й чанки з гри, натисни «Скасувати» і вибери його в полі «Шар».`)) return;
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
      if (fromSchem.schem?.height) fd.set('modelHeight', fromSchem.schem.height);
      fd.set('sliceTop', form.topY.value);
      fd.set('sliceBottom', form.bottomY.value);
      if (tx) fd.set('colors', JSON.stringify(tx.blockColors(fromSchem.schem, fromSchem.tiles)));
      status.textContent = `Завантажую ${(blob.size / MB).toFixed(1)} МБ…`;
      const layer = await api('map', { method: 'POST', body: fd });
      store.set('schemCorner:' + fromSchem.file.name, JSON.stringify({ minX: form.minX.value, minY: form.minY.value, minZ: form.minZ.value }));
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
    const [buf, { createViewer }, { pixelBlocks, pack }, colors] = await Promise.all([
      fetch(`/api/schematics/${s.id}/file?preview`).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }),
      import('./voxel.js'),
      pixelKit(),
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
    let baked = null;
    const pixels = pixelBlocks(parsed.states || parsed.palette, colors, pack);
    const draw = () => preview.setModel(parsed, { hideNatural: cb.checked, keepView: true, colors, baked: baked || pixels });
    cb.addEventListener('change', draw);
    draw();
    // Якщо в цьому браузері є файли гри, прев’ю теж з текстурами.
    getPacks().then((assets) => assets && bakedFor(parsed)).then((b) => {
      if (!b || !box.isConnected || !preview) return;
      baked = b;
      draw();
    }).catch((e) => console.warn('Прев’ю без текстур:', e));
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
  state.schematics = isResident() ? await api('schematics') : [];
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
  state.tasks = isResident() ? await api('tasks') : [];
  renderTasks();
}

// ---------- Лор: історія міста й жителі ----------
// Читати може кожен. Розділи історії пише редактор, профіль жителя — редактор або сам житель,
// якщо профіль прив’язаний до його акаунта. Скіни малює skin.js: плоскі на картках, 3D у профілі.
const skinKit = () => import('./skin.js');
const lore = { members: [], chapters: [], skins: new Map(), viewer: null, open: null };
const memberSkinUrl = (m) => {
  const v = m.skin || m.nick || m.account; // без ніка сервер пробує логін на сайті
  return v ? `/api/members/${m.id}/skin?v=${encodeURIComponent(v)}` : null;
};
const myMember = () => (state.me?.user && !state.me.admin ? lore.members.find((m) => m.user_id === state.me.user.id) : null);
const canEditMember = (m) => isEditor() || (!!m && !!state.me?.user && !state.me.admin && m.user_id === state.me.user.id);

// Скін як полотно 64×64 (або null, якщо скіна немає). Кешується за адресою, яка міняється разом зі скіном.
function memberSkin(m) {
  const url = memberSkinUrl(m);
  if (!url) return Promise.resolve(null);
  if (!lore.skins.has(url)) {
    lore.skins.set(url, (async () => {
      const kit = await skinKit();
      return kit.normalize(await kit.loadImage(url));
    })().catch(() => null));
  }
  return lore.skins.get(url);
}

function nickSkin(nick) {
  const url = '/api/skin/' + encodeURIComponent(nick);
  if (!lore.skins.has(url)) {
    lore.skins.set(url, skinKit().then(async (kit) => kit.normalize(await kit.loadImage(url))).catch(() => null));
  }
  return lore.skins.get(url);
}

// Простий текст лору: порожній рядок — новий абзац, ## — заголовок, **жирний**, *курсив*, @Нік — житель.
function loreInline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<i>$2</i>')
    .replace(/(^|[\s(«"])@([\p{L}\p{N}_]{1,32})/gu, (all, pre, name) => {
      const m = lore.members.find((x) => [x.nick, x.name].some((n) => n && n.toLowerCase() === name.toLowerCase()));
      return m ? `${pre}<a class="mention" href="#p=${m.id}" data-member="${m.id}">${esc(m.name)}</a>` : all;
    });
}
function prose(text) {
  return String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map((block) => {
    const lines = block.trim().split('\n');
    if (!lines[0]) return '';
    let out = '';
    if (/^#{2,3}\s+/.test(lines[0])) out += `<h3>${loreInline(lines.shift().replace(/^#+\s+/, ''))}</h3>`;
    if (lines.length) out += `<p>${lines.map(loreInline).join('<br>')}</p>`;
    return out;
  }).join('');
}
const firstLines = (text, n = 220) => {
  const t = String(text || '').replace(/^#+\s+.*$/gm, '').replace(/[*@]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n).replace(/\s\S*$/, '') + '…' : t;
};

async function loadLore() {
  const [members, chapters] = await Promise.all([api('members'), api('lore')]);
  lore.members = members;
  lore.chapters = chapters;
  renderMembers();
  renderLore();
}

function renderMembers() {
  const q = $('#memberSearch').value.trim().toLowerCase();
  const mine = myMember();
  const list = lore.members.filter((m) => !q || [m.name, m.nick, m.title].some((s) => s && s.toLowerCase().includes(q)));
  $('#membersCount').textContent = lore.members.length || '';
  const btn = $('#myProfileBtn');
  btn.hidden = !state.me?.user || state.me.admin;
  btn.textContent = mine ? 'Мій профіль' : '+ Мій профіль';
  const grid = $('#memberGrid');
  if (!lore.members.length) {
    grid.innerHTML = `<p class="empty">Тут з’являться жителі міста зі своїми скінами й історіями.${state.me?.user ? ' Почни зі свого профілю.' : ''}</p>`;
    return;
  }
  if (!list.length) { grid.innerHTML = '<p class="empty">Нікого не знайдено</p>'; return; }
  grid.innerHTML = list.map((m) => `
    <button type="button" class="member-card${m === mine ? ' mine' : ''}" data-member="${m.id}">
      <div class="fig" data-fig="${m.id}"><span class="fig-empty"></span></div>
      <h3>${esc(m.name)}</h3>
      ${m.title ? `<span class="role">${esc(m.title)}</span>` : ''}
      ${m.bio ? `<p class="bio">${esc(m.bio)}</p>` : ''}
    </button>`).join('');
  for (const m of list) {
    memberSkin(m).then(async (skin) => {
      const fig = $(`[data-fig="${m.id}"]`, grid);
      if (!skin || !fig) return;
      const c = (await skinKit()).drawFront(skin, 4);
      c.setAttribute('aria-hidden', 'true');
      fig.replaceChildren(c);
    });
  }
}
$('#memberSearch').addEventListener('input', renderMembers);
$('#memberGrid').addEventListener('click', (e) => {
  const card = e.target.closest('[data-member]');
  if (card) openMemberView(Number(card.dataset.member));
});

function renderLore() {
  const list = $('#loreList');
  if (!lore.chapters.length) {
    list.innerHTML = `<li class="empty">Історію міста ще не записано.${isEditor() ? ' Натисни «+ Розділ», щоб почати.' : ''}</li>`;
    list.classList.add('is-empty');
    return;
  }
  list.classList.remove('is-empty');
  list.innerHTML = lore.chapters.map((c) => `
    <li class="lore-item">
      <button type="button" class="lore-card" data-lore="${c.id}">
        <div>
          ${c.era ? `<span class="era">${esc(c.era)}</span>` : ''}
          <h3>${esc(c.title)}</h3>
          <p>${esc(firstLines(c.body))}</p>
        </div>
        ${c.cover ? `<img src="/api/lore/${c.id}/cover?v=${esc(c.cover)}" alt="" loading="lazy">` : ''}
      </button>
    </li>`).join('');
}
$('#loreList').addEventListener('click', (e) => {
  const card = e.target.closest('[data-lore]');
  if (card) openLoreView(Number(card.dataset.lore));
});

// --- Панель читання: профіль або розділ ---
function closeLoreDrawer() {
  lore.viewer?.dispose();
  lore.viewer = null;
  lore.open = null;
  $('#loreDrawer').hidden = true;
  if (/^#(p|l)=/.test(location.hash)) history.replaceState(null, '', location.pathname);
}
$('#loreDrawer [data-close]').addEventListener('click', closeLoreDrawer);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('dialog[open]') && !$('#loreDrawer').hidden) closeLoreDrawer(); });
$('#loreDrawerBody').addEventListener('click', (e) => {
  const a = e.target.closest('a.mention');
  if (a) { e.preventDefault(); openMemberView(Number(a.dataset.member)); }
});

function openMemberView(id) {
  const m = lore.members.find((x) => x.id === id);
  if (!m) return;
  lore.viewer?.dispose();
  lore.viewer = null;
  lore.open = { kind: 'member', id };
  history.replaceState(null, '', '#p=' + id);
  const home = m.home_marker ? state.markers.find((x) => x.id === m.home_marker) : null;
  const body = $('#loreDrawerBody');
  body.innerHTML = `
    <div class="profile-top">
      <div class="skin3d" data-skin3d><div class="status">Завантажую скін…</div></div>
      <div>
        <h2>${esc(m.name)}</h2>
        ${m.title ? `<div class="role">${esc(m.title)}</div>` : ''}
        ${m.bio ? `<p class="bio">${esc(m.bio)}</p>` : ''}
        <dl>
          ${m.nick ? `<dt>Нік</dt><dd class="mono">${esc(m.nick)}</dd>` : ''}
          ${m.since ? `<dt>У місті з</dt><dd>${esc(m.since)}</dd>` : ''}
          ${home ? `<dt>Дім</dt><dd>${esc(home.name)}</dd>` : ''}
        </dl>
      </div>
    </div>
    <div class="prose">${m.story ? prose(m.story) : `<p class="muted">Історію ${esc(m.name)} ще не написано.</p>`}</div>
    <div class="actions">
      ${home ? '<button type="button" class="btn" data-act="home">Дім на мапі</button>' : ''}
      ${m.nick ? '<button type="button" class="btn" data-act="nick">Скопіювати нік</button>' : ''}
      ${canEditMember(m) ? '<button type="button" class="btn primary" data-act="edit">Редагувати</button>' : ''}
    </div>`;
  $('#loreDrawer').hidden = false;
  $('#loreDrawer').scrollTop = 0;
  const act = (name, fn) => { const b = $(`[data-act=${name}]`, body); if (b) b.onclick = fn; };
  act('home', () => { closeLoreDrawer(); showView('map'); flyToMarker(home); });
  act('nick', async () => {
    try { await navigator.clipboard.writeText(m.nick); toast('Скопійовано: ' + m.nick); } catch { toast(m.nick); }
  });
  act('edit', () => openMemberEdit(m));

  const box = $('[data-skin3d]', body);
  memberSkin(m).then(async (skin) => {
    if (!box.isConnected || lore.open?.id !== id) return;
    if (!skin) {
      $('.status', box).textContent = m.nick ? `Скіна для «${m.nick}» не знайшлося. Можна завантажити свій PNG у профілі.` : 'Скін ще не додано';
      return;
    }
    const kit = await skinKit();
    try {
      const v = await kit.createSkinViewer(box, skin);
      if (!box.isConnected || lore.open?.id !== id) { v.dispose(); return; }
      lore.viewer = v;
      $('.status', box)?.remove();
    } catch {
      // Без WebGL показуємо плоску фігуру.
      const c = kit.drawFront(skin, 8);
      box.replaceChildren(c);
      c.style.cssText = 'width:auto;height:90%;margin:auto;image-rendering:pixelated;cursor:default';
      box.style.display = 'grid';
    }
  });
}

function openLoreView(id) {
  const c = lore.chapters.find((x) => x.id === id);
  if (!c) return;
  lore.viewer?.dispose();
  lore.viewer = null;
  lore.open = { kind: 'lore', id };
  history.replaceState(null, '', '#l=' + id);
  const cover = c.cover ? `/api/lore/${c.id}/cover?v=${encodeURIComponent(c.cover)}` : null;
  const body = $('#loreDrawerBody');
  body.innerHTML = `
    ${c.era ? `<span class="era">${esc(c.era)}</span>` : ''}
    <h2>${esc(c.title)}</h2>
    ${cover ? `<img class="cover" src="${esc(cover)}" alt="" data-act="cover">` : ''}
    <div class="prose">${prose(c.body) || '<p class="muted">Розділ поки порожній.</p>'}</div>
    <p class="muted small-note">${c.author ? esc(c.author) + ' · ' : ''}${fmtDate(c.updated_at)}</p>
    <div class="actions">${isEditor() ? '<button type="button" class="btn primary" data-act="edit">Редагувати</button>' : ''}</div>`;
  $('#loreDrawer').hidden = false;
  $('#loreDrawer').scrollTop = 0;
  const coverEl = $('[data-act=cover]', body);
  if (coverEl) coverEl.onclick = () => openViewer([{ full: cover, thumb: cover }], 0, c.title);
  const edit = $('[data-act=edit]', body);
  if (edit) edit.onclick = () => openLoreEdit(c);
}

// --- Розділ лору: створення й редагування (редактор) ---
const loreEdit = { chapter: null, file: null, url: null, drop: false };
function renderCoverPick() {
  const f = $('#loreForm');
  const { chapter, url, drop } = loreEdit;
  const src = url || (!drop && chapter?.cover ? `/api/lore/${chapter.id}/cover?v=${encodeURIComponent(chapter.cover)}` : null);
  $('[data-cover-thumb]', f).innerHTML = src ? `<img src="${esc(src)}" alt="">` : '';
  $('[data-cover-drop]', f).hidden = !src;
}
function setCover(file) {
  if (loreEdit.url) URL.revokeObjectURL(loreEdit.url);
  loreEdit.file = file;
  loreEdit.url = file ? URL.createObjectURL(file) : null;
  renderCoverPick();
}
function openLoreEdit(c) {
  const f = $('#loreForm');
  f.reset();
  loreEdit.chapter = c || null;
  loreEdit.drop = false;
  setCover(null);
  $('[data-title]', f).textContent = c ? 'Розділ лору' : 'Новий розділ';
  if (c) { f.title.value = c.title; f.era.value = c.era || ''; f.body.value = c.body || ''; f.pos.value = c.pos; }
  $('[data-delete]', f).hidden = !c;
  openDialog('#loreDialog');
}
$('#addLoreBtn').addEventListener('click', () => openLoreEdit(null));
$('#loreForm [data-cover-add]').addEventListener('click', () => $('#loreForm [data-cover-file]').click());
$('#loreForm [data-cover-file]').addEventListener('change', (e) => { if (e.target.files[0]) setCover(e.target.files[0]); e.target.value = ''; });
$('#loreForm [data-cover-drop]').addEventListener('click', () => { loreEdit.drop = true; setCover(null); });
$('#loreDialog').addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (file) { e.preventDefault(); setCover(file); }
});
$('#loreDialog').addEventListener('close', () => setCover(null));
$('#loreForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    const body = { title: f.title.value, era: f.era.value, body: f.body.value };
    if (f.pos.value !== '') body.pos = Number(f.pos.value);
    const c = loreEdit.chapter
      ? await api('lore/' + loreEdit.chapter.id, { method: 'PATCH', json: body })
      : await api('lore', { method: 'POST', json: body });
    if (loreEdit.file) {
      const pic = await preparePic(loreEdit.file);
      const form = new FormData();
      form.append('image', pic.blob, 'cover');
      await api(`lore/${c.id}/cover`, { method: 'PUT', body: form });
    } else if (loreEdit.drop && loreEdit.chapter?.cover) {
      await api(`lore/${c.id}/cover`, { method: 'DELETE' });
    }
    f.closest('dialog').close();
    await loadLore();
    openLoreView(c.id);
    toast('Розділ збережено');
  });
});
$('#loreForm [data-delete]').addEventListener('click', async () => {
  const f = $('#loreForm');
  const c = loreEdit.chapter;
  if (!c || !confirm(`Видалити розділ «${c.title}»?`)) return;
  try {
    await api('lore/' + c.id, { method: 'DELETE' });
    f.closest('dialog').close();
    closeLoreDrawer();
    await loadLore();
  } catch (err) { showError(f, err.message); }
});

// --- Профіль жителя: створення й редагування ---
const memberEdit = { member: null, file: null, skin: null, drop: false };
async function renderSkinPick() {
  const f = $('#memberForm');
  const box = $('[data-skin-preview]', f);
  const { member, skin, drop } = memberEdit;
  $('[data-skin-drop]', f).hidden = !(skin || (member?.skin && !drop));
  const nick = f.nick.value.trim();
  // Без свого файлу показуємо скін ліцензії за тим ніком, що зараз у полі.
  let shown = skin;
  if (!shown && member?.skin && !drop) shown = await memberSkin(member);
  if (!shown && /^[A-Za-z0-9_]{1,16}$/.test(nick)) shown = await nickSkin(nick);
  if (!f.closest('dialog').open) return;
  const kit = await skinKit();
  if (shown) box.replaceChildren(kit.drawFront(shown, 4));
  else box.innerHTML = '<span class="muted">Без скіна</span>';
  $('[data-skin-hint]', f).textContent = skin ? 'Новий скін збережеться разом із профілем.'
    : member?.skin && !drop ? 'Завантажено свій скін.'
    : shown ? 'Скін ліцензії за ніком, оновлюється сам.'
    : 'Без файлу скін береться за ніком, якщо в гравця ліцензія.';
}
function openMemberEdit(m, prefill = {}) {
  const f = $('#memberForm');
  f.reset();
  memberEdit.member = m || null;
  memberEdit.file = null; memberEdit.skin = null; memberEdit.drop = false;
  $('[data-title]', f).textContent = m ? 'Профіль жителя' : 'Новий житель';
  const sel = f.home_marker;
  sel.innerHTML = '<option value="">не вказано</option>' + [...state.markers]
    .sort((a, b) => a.name.localeCompare(b.name, 'uk'))
    .map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  const v = { ...(m || {}), ...prefill };
  f.name.value = v.name || ''; f.nick.value = v.nick || ''; f.title.value = v.title || '';
  f.since.value = v.since || ''; f.bio.value = v.bio || ''; f.story.value = v.story || '';
  f.account.value = v.account || '';
  sel.value = v.home_marker ? String(v.home_marker) : '';
  $('[data-delete]', f).hidden = !m;
  openDialog('#memberDialog');
  renderSkinPick();
  if (state.me?.admin) {
    api('users').then((users) => {
      $('#accountNames').innerHTML = users.map((u) => `<option value="${esc(u.username)}">`).join('');
    }).catch(() => {});
  }
}
$('#addMemberBtn').addEventListener('click', () => openMemberEdit(null));
$('#myProfileBtn').addEventListener('click', () => {
  const mine = myMember();
  if (mine) openMemberView(mine.id);
  else openMemberEdit(null, { name: state.me.user.username, nick: state.me.user.username });
});
$('#memberForm [data-skin-add]').addEventListener('click', () => $('#memberForm [data-skin-file]').click());
$('#memberForm [data-skin-drop]').addEventListener('click', () => {
  memberEdit.file = null; memberEdit.skin = null; memberEdit.drop = true;
  renderSkinPick();
});
$('#memberForm').nick.addEventListener('change', () => renderSkinPick());
$('#memberForm').nick.addEventListener('input', () => {
  clearTimeout(memberEdit.nickTimer);
  memberEdit.nickTimer = setTimeout(renderSkinPick, 600);
});
$('#memberForm [data-skin-file]').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const f = $('#memberForm');
  showError(f, '');
  try {
    if (file.size > 64 * 1024) throw new Error('Файл скіна завеликий');
    const kit = await skinKit();
    const url = URL.createObjectURL(file);
    const img = await kit.loadImage(url).finally(() => URL.revokeObjectURL(url));
    if (img.width !== 64 || (img.height !== 64 && img.height !== 32)) throw new Error('Скін має бути PNG 64×64 (або старий 64×32)');
    memberEdit.file = file;
    memberEdit.skin = kit.normalize(img);
    memberEdit.drop = false;
    renderSkinPick();
  } catch (err) { showError(f, err.message); }
});
$('#memberForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    const body = {
      name: f.name.value, nick: f.nick.value, title: f.title.value, since: f.since.value,
      bio: f.bio.value, story: f.story.value, home_marker: f.home_marker.value || null,
    };
    if (isEditor()) body.account = f.account.value;
    const cur = memberEdit.member;
    let m = cur
      ? await api('members/' + cur.id, { method: 'PATCH', json: body })
      : await api('members', { method: 'POST', json: body });
    if (memberEdit.file) {
      m = await api(`members/${m.id}/skin`, { method: 'PUT', body: memberEdit.file, headers: { 'content-type': 'image/png' } });
    } else if (memberEdit.drop && cur?.skin) {
      m = await api(`members/${m.id}/skin`, { method: 'DELETE' });
    }
    f.closest('dialog').close();
    await loadLore();
    openMemberView(m.id);
    toast('Профіль збережено');
  });
});
$('#memberForm [data-delete]').addEventListener('click', async () => {
  const f = $('#memberForm');
  const m = memberEdit.member;
  if (!m || !confirm(`Видалити профіль «${m.name}»?`)) return;
  try {
    await api('members/' + m.id, { method: 'DELETE' });
    f.closest('dialog').close();
    closeLoreDrawer();
    await loadLore();
  } catch (err) { showError(f, err.message); }
});

// Посилання #p=<житель> і #l=<розділ> відкривають вкладку «Лор» одразу на потрібному.
function openLoreHash() {
  const m = location.hash.match(/^#(p|l)=(\d+)$/);
  if (!m) return false;
  showView('lore');
  if (m[1] === 'p') openMemberView(Number(m[2]));
  else openLoreView(Number(m[2]));
  return true;
}
addEventListener('hashchange', openLoreHash);

// ---------- Старт ----------
(async () => {
  setSession(await api('auth').catch(() => null));
  // Раніше браузер пам’ятав пароль редактора: один раз міняємо його на звичайний вхід адміністратора.
  const oldPass = store.get('editPassword');
  if (oldPass) {
    store.set('editPassword', null);
    if (!isResident()) {
      setSession(await api('auth', { method: 'POST', json: { username: 'admin', password: oldPass } }).catch(() => null));
    }
  }
  try {
    const loreReady = loadLore().then(() => true, (err) => toast('Не вдалося завантажити лор: ' + err.message));
    await Promise.all([loadLayers(), loadSchematics(), loadTasks(), loadMarkers()]);
    renderCityMap();
    fitCity();
    updateBluemapButton();
    if (store.get('mapMode') === '3d' && currentLayer()?.model) setMode('3d');
    const m = location.hash.match(/^#s=(.+)$/);
    if (m && isResident()) openSchematic(m[1]);
    else if (m) openDialog('#loginDialog');
    if (await loreReady) openLoreHash();
  } catch (err) {
    toast('Не вдалося завантажити дані: ' + err.message);
  }
  if (!visits.entrySent) trackVisit(v3d.mode === '3d' ? 'map3d' : 'map');
})();

// ---------- Відвідуваність ----------
// Кожен браузер має випадковий id у localStorage: за ним сервер рахує унікальних відвідувачів.
// Перше повідомлення за завантаження сторінки — це візит, далі — відкриті розділи
// (той самий розділ рахуємо не частіше ніж раз на 5 хвилин).
const visits = { entrySent: false, last: {} };
function visitorId() {
  let id = store.get('visitorId');
  if (!/^[0-9a-f]{32}$/.test(id || '')) {
    id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    store.set('visitorId', id);
  }
  return id;
}
function trackVisit(section) {
  const now = Date.now();
  if (visits.entrySent && now - (visits.last[section] || 0) < 5 * 60_000) return;
  visits.last[section] = now;
  const body = { vid: visitorId(), section };
  if (!visits.entrySent) { body.entry = 1; body.ref = document.referrer || ''; visits.entrySent = true; }
  fetch('/api/visit', {
    method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {});
}

const SECTION_NAMES = { map: 'Мапа', map3d: 'Мапа 3D', schematics: 'Схематики', tasks: 'Завдання', lore: 'Лор' };
let statsDays = Number(store.get('statsDays')) || 30;
let statsBusy = 0;
async function loadStats() {
  const body = $('#statsBody');
  $$('#statsDays button').forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === statsDays));
  const ticket = ++statsBusy;
  if (!body.dataset.loaded) body.innerHTML = '<p class="empty">Завантаження…</p>';
  try {
    const s = await api(`stats?days=${statsDays}&tz=${-new Date().getTimezoneOffset()}`);
    if (ticket !== statsBusy) return;
    body.dataset.loaded = '1';
    renderStats(s);
  } catch (err) {
    if (ticket === statsBusy) body.innerHTML = `<p class="empty">Не вдалося завантажити: ${esc(err.message)}</p>`;
  }
}
$('#statsDays').addEventListener('click', (e) => {
  const b = e.target.closest('[data-days]');
  if (!b) return;
  statsDays = Number(b.dataset.days);
  store.set('statsDays', String(statsDays));
  loadStats();
});
$('#statsRefresh').addEventListener('click', loadStats);

const fmtNum = (n) => Number(n || 0).toLocaleString('uk-UA');
const fmtDay = (d, opts) => new Date(d + 'T12:00:00').toLocaleDateString('uk-UA', opts);
function fmtAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 2) return 'щойно';
  if (min < 60) return `${min} хв тому`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} год тому`;
  return new Date(ts).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
}
function statsChart(daily) {
  // Малюємо в справжню ширину блоку, щоб підписи на телефоні не ставали дрібними.
  const W = Math.max(300, Math.round($('#statsBody').clientWidth - 28)), H = W < 500 ? 200 : 240, top = 14, bottom = 26, left = 34, right = 8;
  const max = Math.max(1, ...daily.map((d) => Math.max(d.visitors, d.visits)));
  // Красива верхня межа шкали: 1, 2, 5, 10, 20, 50…
  const step = [1, 2, 5].map((m) => m * 10 ** Math.floor(Math.log10(max))).find((v) => v * 4 >= max) || 10 ** Math.ceil(Math.log10(max));
  const ceil = Math.ceil(max / step) * step;
  const ih = H - top - bottom, iw = W - left - right;
  const bw = iw / daily.length;
  const y = (v) => top + ih - (v / ceil) * ih;
  const grid = [];
  for (let v = 0; v <= ceil; v += step) {
    grid.push(`<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${left - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}</text>`);
  }
  const every = Math.ceil(daily.length / Math.max(3, Math.floor(iw / 70)));
  const bars = daily.map((d, i) => {
    const x = left + i * bw, w = Math.max(1, bw - Math.min(4, bw * 0.25));
    const tip = `${fmtDay(d.day, { weekday: 'short', day: 'numeric', month: 'short' })}: відвідувачів ${d.visitors}, візитів ${d.visits}, переглядів ${d.views}`;
    const label = (daily.length - 1 - i) % every === 0
      ? `<text x="${x + bw / 2}" y="${H - 8}" class="axis" text-anchor="middle">${fmtDay(d.day, { day: 'numeric', month: daily.length > 10 ? 'numeric' : 'short' })}</text>` : '';
    return `<g><title>${esc(tip)}</title><rect x="${x}" y="${top}" width="${bw}" height="${ih}" class="hit"/>`
      + `<rect x="${x + (bw - w) / 2}" y="${y(d.visitors)}" width="${w}" height="${top + ih - y(d.visitors)}" class="bar"/>`
      + (d.visits ? `<rect x="${x + (bw - w) / 2}" y="${y(d.visits) - 1}" width="${w}" height="2" class="tick"/>` : '')
      + `</g>${label}`;
  }).join('');
  return `<svg class="stats-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Відвідувачі по днях">${grid.join('')}${bars}</svg>`;
}
let statsLast = null;
addEventListener('resize', () => {
  clearTimeout(statsLast?.timer);
  if (statsLast && $('#view-stats').classList.contains('active')) statsLast.timer = setTimeout(() => renderStats(statsLast), 200);
});
function renderStats(s) {
  statsLast = s;
  const p = s.period, t = s.today;
  const tile = (label, value, note = '') =>
    `<div class="stat-tile"><span class="stat-label">${label}</span><b class="stat-value">${fmtNum(value)}</b>${note ? `<span class="muted stat-note">${note}</span>` : ''}</div>`;
  const sectionMax = Math.max(1, ...s.sections.map((x) => x.views));
  const noData = !s.total.since;
  $('#statsBody').innerHTML = `
    <div class="stat-tiles">
      ${tile('Зараз на сайті', s.active, 'за останні 15 хв')}
      ${tile('Сьогодні', t.visitors, `відвідувачів · візитів ${fmtNum(t.visits)}`)}
      ${tile(`За ${s.days} дн.`, p.visitors, `відвідувачів · візитів ${fmtNum(p.visits)}`)}
      ${tile('Переглядів розділів', p.views, `за ${s.days} дн.`)}
      ${tile('Жителів заходило', p.users, `з логіном, за ${s.days} дн.`)}
    </div>
    ${noData ? '<p class="empty">Ще нікого не пораховано. Лічильник працює з цієї хвилини.</p>' : `
    <section class="stats-block">
      <div class="lore-head"><h2>По днях</h2>
        <span class="legend"><i class="lg-bar"></i>відвідувачі <i class="lg-tick"></i>візити</span></div>
      <div class="stats-card">${statsChart(s.daily)}</div>
    </section>
    <div class="stats-cols">
      <section class="stats-block">
        <div class="lore-head"><h2>Розділи</h2></div>
        <ul class="stats-list">${s.sections.map((x) => `
          <li><span class="sl-name">${esc(SECTION_NAMES[x.section] || x.section)}</span>
            <span class="sl-bar"><i style="width:${(x.views / sectionMax) * 100}%"></i></span>
            <span class="sl-num">${fmtNum(x.views)} <span class="muted">· ${fmtNum(x.visitors)} осіб</span></span></li>`).join('')
          || '<li class="muted">Немає даних</li>'}</ul>
      </section>
      <section class="stats-block">
        <div class="lore-head"><h2>Звідки приходять</h2></div>
        <ul class="stats-list">${s.refs.map((x) => `
          <li><span class="sl-name">${esc(x.ref)}</span><span class="sl-num">${fmtNum(x.visits)}</span></li>`).join('')
          || '<li class="muted">Переважно напряму: з закладки або посилання в грі чи месенджері</li>'}</ul>
      </section>
    </div>
    <section class="stats-block">
      <div class="lore-head"><h2>Жителі з логіном <span class="count">${s.users.length}</span></h2></div>
      ${s.users.length ? `<div class="stats-card table-wrap"><table class="stats-table">
        <thead><tr><th>Житель</th><th>Днів</th><th>Візитів</th><th>Переглядів</th><th>Останній раз</th></tr></thead>
        <tbody>${s.users.map((u) => `<tr><td><b>${esc(u.user)}</b></td><td>${u.days}</td><td>${fmtNum(u.visits)}</td><td>${fmtNum(u.views)}</td><td>${fmtAgo(u.last)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">За цей період ніхто не заходив під своїм логіном.</p>'}
    </section>
    <p class="muted stat-note">Рахуємо з ${new Date(s.total.since).toLocaleDateString('uk-UA')}. Відвідувач — один браузер, візит — одне відкриття сайту.
      Гості без логіну анонімні: ми не зберігаємо ні IP, ні імен.</p>`}`;
}
