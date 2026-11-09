// Текстури блоків із файлу гри: .jar клієнта Minecraft або ресурспак .zip.
// Файл читається тільки в браузері й нікуди не завантажується: з нього малюється мапа
// і рахуються середні кольори блоків для 3D.
import { blockColor, isAir } from './blocks.js';

const T = 16; // розмір плитки одного блока, як у ванільних текстур

// ---------- Читання zip (jar — це теж zip) ----------
class Zip {
  constructor(file, entries) { this.file = file; this.entries = entries; }

  static async open(file) {
    const tailSize = Math.min(file.size, 65557 + 20);
    const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('це не zip і не jar');
    let count = tail.getUint16(eocd + 10, true);
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOffset = tail.getUint32(eocd + 16, true);
    const loc = eocd - 20;
    if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) { // ZIP64
      const at = Number(tail.getBigUint64(loc + 8, true));
      const z64 = new DataView(await file.slice(at, at + 56).arrayBuffer());
      if (z64.getUint32(0, true) === 0x06064b50) {
        count = Number(z64.getBigUint64(32, true));
        cdSize = Number(z64.getBigUint64(40, true));
        cdOffset = Number(z64.getBigUint64(48, true));
      }
    }
    const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    const entries = new Map();
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
      if (cd.getUint32(p, true) !== 0x02014b50) break;
      const method = cd.getUint16(p + 10, true);
      let csize = cd.getUint32(p + 20, true);
      let usize = cd.getUint32(p + 24, true);
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      let offset = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
      if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) {
        for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end;) {
          const id = cd.getUint16(e, true), size = cd.getUint16(e + 2, true);
          if (id === 1) {
            let q = e + 4;
            if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
            if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
            if (offset === 0xffffffff) offset = Number(cd.getBigUint64(q, true));
          }
          e += 4 + size;
        }
      }
      entries.set(name, { method, csize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new Zip(file, entries);
  }

  has(name) { return this.entries.has(name); }

  async read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const head = new DataView(await this.file.slice(e.offset, e.offset + 30).arrayBuffer());
    if (head.getUint32(0, true) !== 0x04034b50) throw new Error('пошкоджений файл ' + name);
    const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const blob = this.file.slice(start, start + e.csize);
    if (e.method === 0) return new Uint8Array(await blob.arrayBuffer());
    if (e.method === 8) {
      const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('невідоме стиснення в ' + name);
  }
}

// ---------- Набір ресурсів: ресурспаки перекривають jar ----------
const loc = (ref) => {
  const i = ref.indexOf(':');
  return i < 0 ? ['minecraft', ref] : [ref.slice(0, i), ref.slice(i + 1)];
};

class Assets {
  constructor(zips, version) {
    this.zips = zips;
    this.version = version;
    this.jsonCache = new Map();
    this.imageCache = new Map();
    this.tintCache = new Map();
  }

  async bytes(path) {
    for (const z of this.zips) if (z.has(path)) return z.read(path);
    return null;
  }

  json(path) {
    if (!this.jsonCache.has(path)) {
      this.jsonCache.set(path, this.bytes(path).then((b) => {
        if (!b) return null;
        try { return JSON.parse(new TextDecoder().decode(b).replace(/^﻿/, '')); } catch { return null; }
      }));
    }
    return this.jsonCache.get(path);
  }

  // Текстура як canvas. В анімованих (кадри один під одним) беремо перший кадр.
  texture(ref) {
    const [ns, path] = loc(ref);
    const file = `assets/${ns}/textures/${path}.png`;
    if (!this.imageCache.has(file)) {
      this.imageCache.set(file, this.bytes(file).then(async (b) => {
        if (!b) return null;
        const bmp = await createImageBitmap(new Blob([b], { type: 'image/png' }));
        const c = canvas(bmp.width, Math.min(bmp.height, bmp.width));
        c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0);
        bmp.close();
        return c;
      }).catch(() => null));
    }
    return this.imageCache.get(file);
  }

  async tinted(ref, tint) {
    const key = ref + '|' + tint;
    if (!this.tintCache.has(key)) {
      this.tintCache.set(key, this.texture(ref).then((src) => {
        if (!src || tint === undefined) return src;
        const c = canvas(src.width, src.height);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(src, 0, 0);
        const img = g.getImageData(0, 0, c.width, c.height);
        const r = (tint >> 16) & 255, gg = (tint >> 8) & 255, b = tint & 255;
        for (let i = 0; i < img.data.length; i += 4) {
          img.data[i] = (img.data[i] * r) / 255;
          img.data[i + 1] = (img.data[i + 1] * gg) / 255;
          img.data[i + 2] = (img.data[i + 2] * b) / 255;
        }
        g.putImageData(img, 0, 0);
        return c;
      }));
    }
    return this.tintCache.get(key);
  }

  blockstate(name) {
    const [ns, path] = loc(name);
    return this.json(`assets/${ns}/blockstates/${path}.json`);
  }

  // Модель з усіма батьками: спільна таблиця текстур і елементи найближчої моделі, де вони є.
  async model(ref) {
    const chain = [];
    let textures = {}, elements = null;
    let cur = ref.includes(':') ? ref : 'minecraft:' + ref;
    for (let depth = 0; cur && depth < 24; depth++) {
      chain.push(cur);
      if (cur.startsWith('minecraft:builtin/')) break;
      const [ns, path] = loc(cur);
      const json = await this.json(`assets/${ns}/models/${path}.json`);
      if (!json) break;
      textures = { ...(json.textures || {}), ...textures };
      if (!elements && Array.isArray(json.elements)) elements = json.elements;
      cur = json.parent ? (json.parent.includes(':') ? json.parent : 'minecraft:' + json.parent) : null;
    }
    return { chain: chain.join(' '), textures, elements: elements || [] };
  }
}

// Відкриває вибрані файли. Ресурспаки (.zip) важливіші за jar гри.
export async function openPacks(files) {
  const list = [...files].sort((a, b) => Number(/\.jar$/i.test(a.name)) - Number(/\.jar$/i.test(b.name)));
  const zips = [];
  let version = '';
  for (const f of list) {
    let z;
    try { z = await Zip.open(f); } catch (e) { throw new Error(`${f.name}: ${e.message}`); }
    let hasStates = false;
    for (const name of z.entries.keys()) {
      if (name.startsWith('assets/') && name.includes('/blockstates/')) { hasStates = true; break; }
    }
    if (!hasStates && ![...z.entries.keys()].some((n) => n.includes('/textures/block/'))) {
      throw new Error(`${f.name}: тут немає текстур блоків. Потрібен .jar самої гри або ресурспак`);
    }
    if (!version && z.has('version.json')) {
      try { version = JSON.parse(new TextDecoder().decode(await z.read('version.json'))).id || ''; } catch { /* без версії */ }
    }
    zips.push(z);
  }
  const assets = new Assets(zips, version);
  if (!(await assets.blockstate('minecraft:stone'))) {
    throw new Error('У вибраних файлах немає моделей блоків. Додай .jar гри (ресурспак сам по собі не містить усіх блоків)');
  }
  return assets;
}

// ---------- Вибір моделей за станом блока ----------
function parseState(state) {
  const m = /^([^[]+)(?:\[(.*)\])?$/.exec(state);
  const name = m ? m[1] : state;
  const props = {};
  if (m && m[2]) {
    for (const kv of m[2].split(',')) {
      const [k, v] = kv.split('=');
      if (k) props[k.trim()] = (v || '').trim();
    }
  }
  return { name: name.includes(':') ? name : 'minecraft:' + name, props };
}

function matchWhen(when, props) {
  if (!when) return true;
  if (Array.isArray(when.OR)) return when.OR.some((w) => matchWhen(w, props));
  if (Array.isArray(when.AND)) return when.AND.every((w) => matchWhen(w, props));
  return Object.entries(when).every(([k, v]) => String(v).split('|').includes(props[k] ?? ''));
}

const asList = (v) => (Array.isArray(v) ? v : [v]);

// Набори моделей для блока: кілька наборів, якщо гра вибирає модель випадково (як у глибинного сланцю).
async function modelSets(assets, state) {
  const { name, props } = parseState(state);
  const bs = await assets.blockstate(name);
  if (!bs) return null;
  if (bs.variants) {
    let chosen = null;
    for (const [key, val] of Object.entries(bs.variants)) {
      const ok = key === '' || key === 'normal' || key.split(',').every((kv) => {
        const [k, v] = kv.split('=');
        return (props[k] ?? '') === v;
      });
      if (ok) { chosen = val; break; }
    }
    if (!chosen) chosen = Object.values(bs.variants)[0];
    if (!chosen) return null;
    const seen = new Set();
    const sets = [];
    for (const v of asList(chosen)) {
      const key = JSON.stringify(v);
      if (seen.has(key)) continue;
      seen.add(key);
      sets.push([v]);
      if (sets.length === 4) break;
    }
    return sets;
  }
  if (Array.isArray(bs.multipart)) {
    const parts = bs.multipart.filter((p) => matchWhen(p.when, props)).map((p) => asList(p.apply)[0]);
    return [parts];
  }
  return null;
}

// ---------- Геометрія ----------
const R = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Кути грані в порядку кутів текстури: верх-ліво, верх-право, низ-право, низ-ліво.
function faceCorners(dir, f, t) {
  switch (dir) {
    case 'up': return [[f[0], t[1], f[2]], [t[0], t[1], f[2]], [t[0], t[1], t[2]], [f[0], t[1], t[2]]];
    case 'down': return [[f[0], f[1], t[2]], [t[0], f[1], t[2]], [t[0], f[1], f[2]], [f[0], f[1], f[2]]];
    case 'north': return [[t[0], t[1], f[2]], [f[0], t[1], f[2]], [f[0], f[1], f[2]], [t[0], f[1], f[2]]];
    case 'south': return [[f[0], t[1], t[2]], [t[0], t[1], t[2]], [t[0], f[1], t[2]], [f[0], f[1], t[2]]];
    case 'west': return [[f[0], t[1], f[2]], [f[0], t[1], t[2]], [f[0], f[1], t[2]], [f[0], f[1], f[2]]];
    case 'east': return [[t[0], t[1], t[2]], [t[0], t[1], f[2]], [t[0], f[1], f[2]], [t[0], f[1], t[2]]];
    default: return null;
  }
}

function defaultUv(dir, f, t) {
  switch (dir) {
    case 'up': return [f[0], f[2], t[0], t[2]];
    case 'down': return [f[0], 16 - t[2], t[0], 16 - f[2]];
    case 'north': return [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]];
    case 'south': return [f[0], 16 - t[1], t[0], 16 - f[1]];
    case 'west': return [f[2], 16 - t[1], t[2], 16 - f[1]];
    case 'east': return [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]];
    default: return [0, 0, 16, 16];
  }
}

// Поворот точки навколо осі за правилом правої руки.
function rotate(p, axis, deg, o) {
  const a = deg * R, c = Math.cos(a), s = Math.sin(a);
  const x = p[0] - o[0], y = p[1] - o[1], z = p[2] - o[2];
  if (axis === 'x') return [p[0], o[1] + y * c - z * s, o[2] + y * s + z * c];
  if (axis === 'y') return [o[0] + x * c + z * s, p[1], o[2] - x * s + z * c];
  return [o[0] + x * c - y * s, o[1] + x * s + y * c, p[2]];
}

function rotateElement(p, rot) {
  if (!rot || !rot.angle) return p;
  const o = rot.origin || [8, 8, 8];
  let q = rotate(p, rot.axis, rot.angle, o);
  if (rot.rescale) {
    const k = 1 / Math.cos(Math.abs(rot.angle) * R);
    q = q.map((v, i) => (i === 'xyz'.indexOf(rot.axis) ? v : o[i] + (v - o[i]) * k));
  }
  return q;
}

// Поворот моделі зі стану блока: спершу x, потім y (у грі обидва за годинниковою, якщо дивитися з боку осі).
const C = [8, 8, 8];
const rotateState = (p, x, y) => {
  let q = p;
  if (x) q = rotate(q, 'x', -x, C);
  if (y) q = rotate(q, 'y', -y, C);
  return q;
};

// ---------- Відтінки ----------
const GRASS = 0x91bd59, FOLIAGE = 0x77ab2f, WATER = 0x3f76e4;
const rgbInt = (r, g, b) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
function redstone(power) {
  const f = power / 15;
  const r = f * 0.6 + (f > 0 ? 0.4 : 0.3);
  const g = Math.min(1, Math.max(0, f * f * 0.7 - 0.5));
  const b = Math.min(1, Math.max(0, f * f * 0.6 - 0.7));
  return rgbInt(r * 255, g * 255, b * 255);
}
function tintFor(name, props) {
  const n = name.replace(/^minecraft:/, '');
  if (n === 'redstone_wire') return redstone(Number(props.power) || 0);
  if (n === 'birch_leaves') return 0x80a755;
  if (n === 'spruce_leaves') return 0x619961;
  if (n === 'mangrove_leaves') return 0x92c648;
  if (/leaves$|^vine$/.test(n)) return FOLIAGE;
  if (n === 'lily_pad') return 0x208030;
  if (/water|bubble_column/.test(n)) return WATER;
  if (/^attached_(melon|pumpkin)_stem$/.test(n)) return 0xe0c71c;
  if (/^(melon|pumpkin)_stem$/.test(n)) {
    const age = Number(props.age) || 0;
    return rgbInt(age * 32, 255 - age * 8, age * 4);
  }
  return GRASS;
}

// ---------- Плитка «вид згори» для одного стану ----------
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Посилання «#line» → «block/redstone_dust_dot». З 1.21.5 текстура в моделі буває й об’єктом
// { sprite, force_translucent }.
function resolveTex(textures, ref) {
  let r = ref;
  for (let i = 0; i < 12 && r; i++) {
    if (typeof r === 'object') r = r.sprite;
    else if (typeof r === 'string' && r.startsWith('#')) r = textures[r.slice(1)];
    else break;
  }
  return typeof r === 'string' && r && !r.startsWith('#') ? r : null;
}

// Малює текстуру на чотирикутник грані (афінно, без згладжування, щоб пікселі лишались чіткими).
function drawFace(g, tex, uvCorners, pts, dark) {
  const s = tex.width / 16;
  const U = uvCorners.map(([u, v]) => [u * s, v * s]);
  const S = pts.map((p) => [p[0], p[2]]); // вид згори: x вправо, z вниз (північ угорі)
  const du1 = [U[1][0] - U[0][0], U[1][1] - U[0][1]], du3 = [U[3][0] - U[0][0], U[3][1] - U[0][1]];
  const ds1 = [S[1][0] - S[0][0], S[1][1] - S[0][1]], ds3 = [S[3][0] - S[0][0], S[3][1] - S[0][1]];
  const det = du1[0] * du3[1] - du3[0] * du1[1];
  if (Math.abs(det) < 1e-9) return;
  const i00 = du3[1] / det, i01 = -du3[0] / det, i10 = -du1[1] / det, i11 = du1[0] / det;
  const a = ds1[0] * i00 + ds3[0] * i10, c = ds1[0] * i01 + ds3[0] * i11;
  const b = ds1[1] * i00 + ds3[1] * i10, d = ds1[1] * i01 + ds3[1] * i11;
  const e = S[0][0] - (a * U[0][0] + c * U[0][1]), f = S[0][1] - (b * U[0][0] + d * U[0][1]);
  g.save();
  g.beginPath();
  S.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.clip();
  g.setTransform(a, b, c, d, e, f);
  g.drawImage(tex, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (dark > 0.004) { // нижчі грані трохи темніші: так видно сходинки й плити
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = `rgba(0,0,0,${dark.toFixed(3)})`;
    g.fill();
  }
  g.restore();
}

const NO_TOP = /ladder|vine|lichen|sculk_vein|sign$|banner$|_button$|tripwire|lever$|_head$|_skull$|skull$|head$/;
const EMPTY = /^minecraft:(air|cave_air|void_air|structure_void|light|barrier|moving_piston)$/;
const BED_COLORS = /^minecraft:(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_bed$/;

async function entityTop(assets, name, props) {
  const facingTurn = { north: 0, east: 90, south: 180, west: 270 }[props.facing] || 0;
  const bed = BED_COLORS.exec(name);
  if (bed) {
    const tex = await assets.texture(`minecraft:entity/bed/${bed[1]}`);
    if (!tex) return null;
    const s = tex.width / 64;
    const v = props.part === 'foot' ? 28 : 6;
    return { tex, src: [6 * s, v * s, 16 * s, 16 * s], dst: [0, 0, 16, 16], turn: facingTurn };
  }
  const chest = /^minecraft:(?:waxed_)?(trapped_chest|ender_chest|chest|copper_chest|exposed_copper_chest|weathered_copper_chest|oxidized_copper_chest)$/.exec(name);
  if (chest) {
    const variant = {
      chest: 'normal', trapped_chest: 'trapped', ender_chest: 'ender', copper_chest: 'copper',
      exposed_copper_chest: 'copper_exposed', weathered_copper_chest: 'copper_weathered', oxidized_copper_chest: 'copper_oxidized',
    }[chest[1]];
    const tex = await assets.texture(`minecraft:entity/chest/${variant}`) || await assets.texture('minecraft:entity/chest/normal');
    if (!tex) return null;
    const s = tex.width / 64;
    return { tex, src: [28 * s, 0, 14 * s, 14 * s], dst: [1, 1, 14, 14], turn: facingTurn };
  }
  return null;
}

// Повертає { tiles: [canvas 16×16, ...варіанти], opaque, empty, top: [r,g,b], side: [r,g,b] }.
async function buildState(assets, state) {
  const { name, props } = parseState(state);
  const out = { tiles: [], opaque: false, empty: true, top: null, side: null };
  if (EMPTY.test(name)) return out;
  const short = name.replace(/^minecraft:/, '');
  const tint = tintFor(name, props);

  // Вода і бульбашки: напівпрозора синя плитка, кілька шарів дають глибину.
  if (/^(water|bubble_column)$/.test(short)) {
    const tex = await assets.tinted('minecraft:block/water_still', WATER);
    if (tex) {
      const c = canvas(T, T);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(tex, 0, 0, T, T);
      out.tiles.push(c);
      return finish(out, c, tex);
    }
  }

  const ent = await entityTop(assets, name, props);
  if (ent) {
    const c = canvas(T, T);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    g.translate(8, 8);
    g.rotate(ent.turn * R);
    g.translate(-8, -8);
    g.drawImage(ent.tex, ...ent.src, ...ent.dst);
    out.tiles.push(c);
    return finish(out, c, null);
  }

  const sets = await modelSets(assets, state);
  if (!sets) return null;
  let sideTex = null, sideArea = 0, sideTint;
  for (const set of sets) {
    const faces = [];
    let sprite = null, particle = null, planes = true, hasElements = false;
    for (const apply of set) {
      if (!apply || !apply.model) continue;
      const model = await assets.model(apply.model);
      particle ||= resolveTex(model.textures, '#particle');
      const rx = Number(apply.x) || 0, ry = Number(apply.y) || 0, uvlock = !!apply.uvlock;
      for (const el of model.elements) {
        if (!el.faces || !el.from || !el.to) continue;
        hasElements = true;
        if (![0, 1, 2].some((i) => el.from[i] === el.to[i])) planes = false;
        for (const [dir, face] of Object.entries(el.faces)) {
          const ref = resolveTex(model.textures, face.texture);
          if (!ref) continue;
          let pts = faceCorners(dir, el.from, el.to);
          if (!pts) continue;
          pts = pts.map((p) => rotateState(rotateElement(p, el.rotation), rx, ry));
          const n = cross(sub(pts[3], pts[0]), sub(pts[1], pts[0]));
          const len = Math.hypot(n[0], n[1], n[2]);
          if (len < 1e-6) continue;
          const ny = n[1] / len;
          const faceTint = face.tintindex !== undefined ? tint : undefined;
          if (Math.abs(ny) < 0.5) {
            // Бокова грань: для кольору боків у 3D і для «спрайта» рослин.
            const area = (el.to[1] - el.from[1]) * Math.max(Math.abs(el.to[0] - el.from[0]), Math.abs(el.to[2] - el.from[2]));
            if (!sprite) sprite = { ref, tint: faceTint };
            if (area > sideArea) { sideArea = area; sideTex = ref; sideTint = faceTint; }
            continue;
          }
          if (ny < 0) continue;
          const uv = face.uv || defaultUv(dir, el.from, el.to);
          let uvc = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
          const k = ((Number(face.rotation) || 0) / 90) & 3;
          if (k) uvc = uvc.map((_, i) => uvc[(i - k + 4) % 4]);
          if (uvlock && (rx || ry)) uvc = pts.map((p) => [p[0], p[2]]); // текстура не крутиться разом із блоком
          const h = pts.reduce((sum, p) => sum + p[1], 0) / 4;
          faces.push({ ref, tint: faceTint, uvc, pts, h });
        }
      }
    }
    const c = canvas(T, T);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    if (faces.length) {
      faces.sort((a, b) => a.h - b.h);
      const hmax = faces[faces.length - 1].h;
      for (const f of faces) {
        const tex = await assets.tinted(f.ref, f.tint);
        const clamp = (v) => Math.max(0, Math.min(1, v));
        // Нижня сходинка помітно темніша за верхню, а плита чи килим — трохи темніші за повний блок.
        if (tex) drawFace(g, tex, f.uvc, f.pts, 0.3 * clamp((hmax - f.h) / 16) + 0.06 * clamp(1 - f.h / 16));
      }
    } else if (sprite && planes && !NO_TOP.test(short)) {
      // Квіти, посіви, вогонь: згори малюємо їхню картинку, інакше вони були б невидимі.
      const tex = await assets.tinted(sprite.ref, sprite.tint);
      if (tex) g.drawImage(tex, 0, 0, T, T);
    } else if (!hasElements && particle && !NO_TOP.test(short)) {
      // Модель без геометрії (лава, шалкерові скрині): малюємо її текстуру частинок.
      const tex = await assets.texture(particle);
      if (tex) g.drawImage(tex, 0, 0, T, T);
    }
    out.tiles.push(c);
  }
  if (!out.tiles.length) return null;
  const side = sideTex ? await assets.tinted(sideTex, sideTint) : null;
  return finish(out, out.tiles[0], side);
}

// Прозорість плитки і середні кольори (верх — для мапи 1:1 і 3D, бік — для стін у 3D).
function finish(out, tile, sideTex) {
  const d = tile.getContext('2d').getImageData(0, 0, T, T).data;
  let r = 0, g = 0, b = 0, a = 0, opaque = true, empty = true;
  for (let i = 0; i < d.length; i += 4) {
    const al = d[i + 3];
    if (al < 255) opaque = false;
    if (al > 0) empty = false;
    r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al;
  }
  out.opaque = opaque;
  out.empty = empty;
  out.top = a ? [r / a, g / a, b / a] : null;
  out.side = sideTex ? average(sideTex) : out.top;
  return out;
}

function average(tex) {
  const d = tex.getContext('2d').getImageData(0, 0, tex.width, tex.height).data;
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < d.length; i += 4) {
    const al = d[i + 3];
    r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al;
  }
  return a ? [r / a, g / a, b / a] : null;
}

// Запасна плитка кольором, якщо блока немає у файлі гри (наприклад, блок із мода).
function colorTile(name) {
  const c = canvas(T, T);
  const g = c.getContext('2d');
  const col = blockColor(name);
  g.fillStyle = '#' + col.toString(16).padStart(6, '0');
  g.fillRect(0, 0, T, T);
  const rgb = [(col >> 16) & 255, (col >> 8) & 255, col & 255];
  return { tiles: [c], opaque: true, empty: false, top: rgb, side: rgb, missing: true };
}

// Плитки для всіх станів схематика. onProgress(done, total) для рядка стану.
export async function buildTiles(assets, states, onProgress) {
  const out = new Array(states.length);
  let missing = 0;
  for (let i = 0; i < states.length; i++) {
    const st = states[i] || 'minecraft:air';
    let t = null;
    try {
      t = await buildState(assets, st);
    } catch (e) {
      console.warn('Блок', st, e);
    }
    if (!t) {
      const name = parseState(st).name;
      t = isAir(name) ? { tiles: [], opaque: false, empty: true, top: null, side: null } : colorTile(name);
      if (t.missing) missing++;
    }
    out[i] = t;
    if (onProgress && (i % 16 === 0 || i === states.length - 1)) {
      onProgress(i + 1, states.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  out.missing = missing;
  return out;
}

// ---------- Мапа з текстурами ----------
// Скільки пікселів на блок: 16 (як у грі), якщо картинка вміщується в ліміти браузера і сховища.
export function pickPx(W, L, want = 16, maxPixels = 24e6) {
  for (let p = want; p >= 1; p /= 2) {
    if (W * p <= 16000 && L * p <= 16000 && W * p * L * p <= maxPixels) return p;
  }
  return 1;
}

// Плитки, зменшені до px пікселів (зі згладжуванням, щоб дрібна мапа не рябіла).
function scaleTiles(tiles, px) {
  const cache = tiles.scaled || (tiles.scaled = new Map());
  if (cache.has(px)) return cache.get(px);
  const out = tiles.map((t) => t.tiles.map((src) => {
    const c = canvas(px, px); // свіжа копія: так браузер швидше малює її на великій мапі
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = px < T;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, px, px);
    return c;
  }));
  cache.set(px, out);
  return out;
}

function shadowTiles(px) {
  const make = (x0, y0, x1, y1) => {
    const c = canvas(px, px);
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(x0 * px, y0 * px, x1 * px, y1 * px);
    grd.addColorStop(0, 'rgba(0,0,0,1)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, px, px);
    return c;
  };
  return { n: make(0, 0, 0, 0.45), s: make(0, 1, 0, 0.55), w: make(0, 0, 0.45, 0), e: make(1, 0, 0.55, 0) };
}

const hash3 = (x, y, z) => {
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};

// Вид згори: у кожному стовпчику йдемо вниз до першого непрозорого блока, а прозорі
// й неповні блоки над ним (скло, вода, смолоскипи, рейки) малюємо поверх нього.
// topY і bottomY рахуються від низу схематика.
export function renderTextured(schem, tiles, { topY = schem.height - 1, bottomY = 0, px = 16 } = {}) {
  const { width: W, length: L, blocks } = schem;
  const WL = W * L;
  const top = Math.min(topY, schem.height - 1), bottom = Math.max(0, bottomY);
  const art = scaleTiles(tiles, px);
  const heights = new Int16Array(WL).fill(-1);
  const base = new Int32Array(WL).fill(-1);
  const over = []; // [col, id, y] для неповних блоків над основою
  for (let col = 0; col < WL; col++) {
    let n = 0;
    for (let y = top; y >= bottom; y--) {
      const id = blocks[col + y * WL];
      const t = tiles[id];
      if (!t || t.empty) continue;
      if (t.opaque) { heights[col] = y; base[col] = id; break; }
      if (n < 6) { over.push(col, id, y); n++; }
    }
  }

  const c = canvas(W * px, L * px);
  const g = c.getContext('2d');
  if (!g) throw new Error('Браузер не може створити таку велику картинку');
  g.imageSmoothingEnabled = false;
  const pick = (id, x, y, z) => {
    const v = art[id];
    return v.length > 1 ? v[hash3(x, y, z) % v.length] : v[0];
  };

  const range = Math.max(1, top - bottom);
  const styles = [];
  for (let i = 0; i <= 64; i++) styles.push(`rgba(0,0,0,${(i / 64).toFixed(4)})`);
  for (let z = 0; z < L; z++) {
    for (let x = 0; x < W; x++) {
      const col = x + z * W;
      const id = base[col];
      if (id < 0) continue;
      const h = heights[col];
      g.drawImage(pick(id, x, h, z), x * px, z * px);
      // Глибше — темніше; як на мапах у грі, вище за північного сусіда — світліше.
      const north = z > 0 ? heights[col - W] : -1;
      let shade = 0.76 + 0.24 * ((h - bottom) / range);
      if (north >= 0) shade *= h > north ? 1 : h === north ? 0.95 : 0.84;
      const a = Math.round((1 - Math.min(1, shade)) * 64);
      if (a > 0) { g.fillStyle = styles[a]; g.fillRect(x * px, z * px, px, px); }
    }
  }

  if (px >= 4) {
    // Тінь від вищих сусідів: стіни «стоять», а не намальовані.
    const sh = shadowTiles(px);
    const near = [[0, -1, sh.n], [0, 1, sh.s], [-1, 0, sh.w], [1, 0, sh.e]];
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        const col = x + z * W;
        const h = heights[col];
        if (h < 0) continue;
        for (const [dx, dz, img] of near) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= W || nz >= L) continue;
          const nh = heights[nx + nz * W];
          if (nh <= h) continue;
          g.globalAlpha = Math.min(1, (nh - h) / 3) * 0.5;
          g.drawImage(img, x * px, z * px);
        }
      }
    }
    g.globalAlpha = 1;
  }

  // Неповні блоки: знизу вгору, щоб верхні лягали поверх нижніх.
  for (let i = over.length - 3; i >= 0; i -= 3) {
    const col = over[i], id = over[i + 1], y = over[i + 2];
    const x = col % W, z = (col - x) / W;
    g.drawImage(pick(id, x, y, z), x * px, z * px);
  }
  return c;
}

// Середні кольори блоків для 3D: { 'minecraft:stone': ['#7d7d7d', '#7d7d7d'], ... } (верх, бік).
export function blockColors(schem, tiles) {
  const counts = new Uint32Array(schem.palette.length);
  for (let i = 0; i < schem.blocks.length; i++) counts[schem.blocks[i]]++;
  const best = new Map();
  schem.palette.forEach((name, i) => {
    const t = tiles[i];
    if (!t || !t.top || t.missing || !name || isAir(name)) return;
    const prev = best.get(name);
    if (!prev || counts[i] > prev.count) best.set(name, { count: counts[i], t });
  });
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const out = {};
  for (const [name, { t }] of best) out[name] = [hex(t.top), hex(t.side || t.top)];
  return out;
}

// ---------- Блоки для 3D ----------
// Кожен стан блока стає набором чотирикутників у клітинці 1×1×1 за справжньою моделлю з гри.
// Текстури лягають в атлас — стос однакових квадратів, по шару на текстуру, — тож у 3D кожна
// грань бере свій шар і сусідні текстури не протікають одна в одну.
//
// Чотирикутник — QUAD чисел: [0..11] кути (x, y, z) проти годинникової стрілки, якщо дивитися ззовні,
// [12..19] uv кутів (0…1), [20] шар атласу, [21] сторона, з якої його закриває сусід (0…5 або -1),
// [22] яскравість грані, [23] вид: 0 непрозорий, 1 з дірками (листя, скло), 2 напівпрозорий (вода, лід).
export const QUAD = 24;
export const DIRS = [[0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]; // up down north south west east
const DIR_NAMES = ['up', 'down', 'north', 'south', 'west', 'east'];

function dirIndex(v) {
  const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
  if (ay >= ax && ay >= az) return v[1] > 0 ? 0 : 1;
  if (az >= ax) return v[2] < 0 ? 2 : 3;
  return v[0] < 0 ? 4 : 5;
}
// Сторона після повороту моделі зі стану блока.
const rotDir = (name, rx, ry) => {
  const d = DIRS[DIR_NAMES.indexOf(name)];
  if (!d) return -1;
  const p = rotateState([8 + d[0] * 8, 8 + d[1] * 8, 8 + d[2] * 8], rx, ry);
  return dirIndex([p[0] - 8, p[1] - 8, p[2] - 8]);
};
// Світло на гранях, як у грі: верх яскравий, боки темніші, низ найтемніший.
const diffuse = (n) => Math.min(1, n[0] * n[0] * 0.6 + n[1] * n[1] * ((3 + n[1]) / 4) + n[2] * n[2] * 0.8);

// uv для «uvlock»: текстура лежить за світовою сіткою, хоч модель і повернута.
const LOCKED_UV = [
  (p) => [p[0], p[2]], (p) => [p[0], 16 - p[2]], (p) => [16 - p[0], 16 - p[1]],
  (p) => [p[0], 16 - p[1]], (p) => [p[2], 16 - p[1]], (p) => [16 - p[2], 16 - p[1]],
];

function alphaKind(c) {
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let clear = 0, semi = 0;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] === 0) clear++;
    else if (d[i] < 255) semi++;
  }
  return semi > (d.length / 4) * 0.15 ? 2 : clear + semi ? 1 : 0;
}

class Atlas {
  constructor(assets) { this.assets = assets; this.index = new Map(); this.list = []; }
  add(key, make) {
    let p = this.index.get(key);
    if (!p) {
      p = Promise.resolve().then(make).then((c) => {
        if (!c) return -1;
        this.list.push({ canvas: c, kind: alphaKind(c) });
        return this.list.length - 1;
      }).catch(() => -1);
      this.index.set(key, p);
    }
    return p;
  }
  texture(ref, tint) { return this.add(`${ref}|${tint ?? ''}`, () => this.assets.tinted(ref, tint)); }
  kind(layer) { return layer >= 0 ? this.list[layer].kind : 0; }
  // Усі шари одного розміру (як у найбільшої текстури, до 64 пікселів) в одному масиві RGBA.
  pack() {
    const size = Math.min(64, Math.max(16, ...this.list.map((t) => t.canvas.width)));
    const data = new Uint8Array(size * size * 4 * Math.max(1, this.list.length));
    const c = canvas(size, size);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    this.list.forEach((t, i) => {
      g.clearRect(0, 0, size, size);
      g.drawImage(t.canvas, 0, 0, size, size);
      const d = g.getImageData(0, 0, size, size).data;
      // Прозорим пікселям даємо середній колір текстури: здалеку (на зменшених копіях) листя
      // й квіти тоді не обростають чорною облямівкою.
      let r = 0, gg = 0, b = 0, n = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k + 3]) { r += d[k]; gg += d[k + 1]; b += d[k + 2]; n++; }
      if (n && n < d.length / 4) {
        for (let k = 0; k < d.length; k += 4) if (!d[k + 3]) { d[k] = r / n; d[k + 1] = gg / n; d[k + 2] = b / n; }
      }
      data.set(d, i * size * size * 4);
    });
    return { size, count: Math.max(1, this.list.length), data };
  }
}

// Грань елемента моделі. pts — кути в порядку кутів текстури (верх-ліво, верх-право, низ-право, низ-ліво),
// а WebGL хоче обхід проти годинникової стрілки ззовні, тому пишемо 0, 3, 2, 1.
function pushQuad(out, pts, uvc, layer, cull, shade, kind) {
  for (const i of [0, 3, 2, 1]) out.push(pts[i][0] / 16, pts[i][1] / 16, pts[i][2] / 16);
  for (const i of [0, 3, 2, 1]) out.push(uvc[i][0] / 16, uvc[i][1] / 16);
  out.push(layer, cull, shade, kind);
}

// Елемент (коробка з гранями) → чотирикутники. layerOf(face) дає шар атласу для грані.
async function addElement(out, atlas, el, layerOf, rx = 0, ry = 0, uvlock = false) {
  if (!el.faces || !el.from || !el.to) return;
  const glow = (Number(el.light_emission) || 0) / 15;
  for (const [dir, face] of Object.entries(el.faces)) {
    let pts = faceCorners(dir, el.from, el.to);
    if (!pts) continue;
    const layer = await layerOf(face);
    if (layer < 0) continue;
    pts = pts.map((p) => rotateState(rotateElement(p, el.rotation), rx, ry));
    const n = cross(sub(pts[3], pts[0]), sub(pts[1], pts[0]));
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-6) continue;
    const nn = [n[0] / len, n[1] / len, n[2] / len];
    let uvc;
    if (uvlock && (rx || ry)) {
      uvc = pts.map(LOCKED_UV[dirIndex(nn)]);
    } else {
      const uv = face.uv || defaultUv(dir, el.from, el.to);
      uvc = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
      const k = ((Number(face.rotation) || 0) / 90) & 3;
      if (k) uvc = uvc.map((_, i) => uvc[(i - k + 4) % 4]);
    }
    // Нові версії замість «shade: false» кажуть, як світити грань: «up» — як верх, тобто без тіні.
    const over = DIRS[DIR_NAMES.indexOf(el.shade_direction_override)];
    const shade = Math.max(over ? diffuse(over) : el.shade === false ? 1 : diffuse(nn), glow);
    pushQuad(out, pts, uvc, layer, face.cullface ? rotDir(face.cullface, rx, ry) : -1, shade, atlas.kind(layer));
  }
}

// Які сторони клітинки модель закриває цілком: непрозорими гранями (такий блок ховає грані сусідів)
// і будь-якими (так скло біля скла не малює стінку між собою).
function shapeOf(q) {
  let solid = 0, full = 0;
  for (let o = 0; o < q.length; o += QUAD) {
    const cull = q[o + 21];
    if (cull < 0) continue;
    const [a, b] = cull < 2 ? [0, 2] : cull < 4 ? [0, 1] : [1, 2];
    let lo = 1, hi = 0, lo2 = 1, hi2 = 0;
    for (let k = 0; k < 4; k++) {
      const u = q[o + k * 3 + a], v = q[o + k * 3 + b];
      lo = Math.min(lo, u); hi = Math.max(hi, u); lo2 = Math.min(lo2, v); hi2 = Math.max(hi2, v);
    }
    if (lo > 0.001 || lo2 > 0.001 || hi < 0.999 || hi2 < 0.999) continue;
    full |= 1 << cull;
    if (q[o + 23] === 0) solid |= 1 << cull;
  }
  return { solid, full };
}

// Скриня малюється грою окремо, без моделі блока: складаємо її з частин текстури entity/chest.
// Частини лежать у текстурі догори дриґом, тому бокові смужки повертаємо на 180°.
const CHEST_PARTS = [
  // [from, to, { сторона: [u, v, w, h, спосіб] }] у пікселях текстури 64×64; спосіб: r — поворот на 180°, f — віддзеркалити по вертикалі
  [[1, 0, 1], [15, 10, 15], { down: [14, 19, 14, 14, 'r'], north: [14, 33, 14, 10, 'r'], south: [42, 33, 14, 10, 'r'], west: [0, 33, 14, 10, 'r'], east: [28, 33, 14, 10, 'r'] }],
  [[1, 9, 1], [15, 14, 15], { up: [28, 0, 14, 14, 'f'], north: [14, 14, 14, 5, 'r'], south: [42, 14, 14, 5, 'r'], west: [0, 14, 14, 5, 'r'], east: [28, 14, 14, 5, 'r'] }],
  [[7, 7, 15], [9, 11, 16], { up: [3, 0, 2, 1, 'f'], down: [1, 0, 2, 1, 'r'], south: [4, 1, 2, 4, 'r'], west: [0, 1, 1, 4, 'r'], east: [3, 1, 1, 4, 'r'] }],
];
const CHEST = /^minecraft:(?:waxed_)?(trapped_chest|ender_chest|chest|copper_chest|exposed_copper_chest|weathered_copper_chest|oxidized_copper_chest)$/;
async function chestQuads(atlas, name, props) {
  const variant = {
    chest: 'normal', trapped_chest: 'trapped', ender_chest: 'ender', copper_chest: 'copper',
    exposed_copper_chest: 'copper_exposed', weathered_copper_chest: 'copper_weathered', oxidized_copper_chest: 'copper_oxidized',
  }[CHEST.exec(name)[1]];
  const tex = await atlas.assets.texture(`minecraft:entity/chest/${variant}`) || await atlas.assets.texture('minecraft:entity/chest/normal');
  if (!tex) return null;
  const s = tex.width / 64;
  // Подвійна скриня: половинки тягнемо до сусідки, щоб між ними не було щілини.
  const grow = props.type === 'left' ? [0, 1] : props.type === 'right' ? [-1, 0] : [0, 0];
  const parts = CHEST_PARTS.map(([f, t, faces], i) => [i < 2 ? [f[0] + grow[0], f[1], f[2]] : f, i < 2 ? [t[0] + grow[1], t[1], t[2]] : t, faces]);
  // Шар на кожну сторону: частини текстури лягають туди, куди на цю сторону дивиться стандартна uv-розгортка.
  const layers = {};
  for (const dir of DIR_NAMES) {
    layers[dir] = await atlas.add(`chest:${variant}:${props.type || ''}:${dir}`, () => {
      const c = canvas(16 * s, 16 * s);
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      let any = false;
      for (const [from, to, faces] of parts) {
        const src = faces[dir];
        if (!src) continue;
        const [u0, v0, u1, v1] = defaultUv(dir, from, to);
        const [sx, sy, sw, sh, how] = src;
        g.save();
        if (how === 'r') { g.translate(u1 * s, v1 * s); g.rotate(Math.PI); } else { g.translate(u0 * s, v1 * s); g.scale(1, -1); }
        g.drawImage(tex, sx * s, sy * s, sw * s, sh * s, 0, 0, (u1 - u0) * s, (v1 - v0) * s);
        g.restore();
        any = true;
      }
      return any ? c : null;
    });
  }
  const ry = { south: 0, west: 90, north: 180, east: 270 }[props.facing] || 0;
  const q = [];
  for (const [from, to, faces] of parts) {
    const el = { from, to, faces: Object.fromEntries(Object.keys(faces).map((d) => [d, { dir: d }])) };
    await addElement(q, atlas, el, (face) => layers[face.dir], 0, ry);
  }
  return q;
}

// Вода й лава: куб текстури «still»; верх рідини опускається до 14/16, якщо над нею не та сама рідина.
async function fluidQuads(atlas, short, top) {
  const lava = short === 'lava';
  const layer = await atlas.texture(lava ? 'minecraft:block/lava_still' : 'minecraft:block/water_still', lava ? undefined : 0x3f76e4);
  if (layer < 0) return null;
  const faces = Object.fromEntries(DIR_NAMES.map((d) => [d, { cullface: d }]));
  const q = [];
  await addElement(q, atlas, { from: [0, 0, 0], to: [16, top, 16], faces }, () => layer);
  if (top < 16) { // верх не прилягає до сусіда, тож його не закриває навіть такий самий блок
    for (let o = 0; o < q.length; o += QUAD) if (q[o + 21] === 0) q[o + 21] = -1;
  }
  return q;
}

// Таблички, прапори й голови гра малює окремо від моделей блоків (голова поршня — звичайна модель).
const NO_3D = /^minecraft:(?!piston_head$)(\w+_)?(sign|wall_sign|hanging_sign|wall_hanging_sign|banner|wall_banner|head|wall_head|skull|wall_skull)$|^minecraft:(conduit|end_portal|end_gateway|moving_piston|bubble_column_top)$/;

// Один стан блока → { variants: [Float32Array...], solid, full, group } або null, якщо в 3D його не малюємо.
async function bakeState(atlas, state) {
  const assets = atlas.assets;
  const { name, props } = parseState(state);
  if (EMPTY.test(name) || NO_3D.test(name)) return null;
  const short = name.replace(/^minecraft:/, '');
  const done = (variants, extra = {}) => {
    const list = variants.filter((v) => v && v.length).map((v) => Float32Array.from(v));
    if (!list.length) return null;
    const { solid, full } = shapeOf(list[0]);
    return { variants: list, solid: solid === 63, full: full === 63, solidMask: solid, group: name, ...extra };
  };

  if (/^(water|bubble_column|lava)$/.test(short)) {
    const group = short === 'lava' ? 'minecraft:lava' : 'minecraft:water';
    return done([await fluidQuads(atlas, short, 16)], { group, surface: Float32Array.from(await fluidQuads(atlas, short, 14) || []) });
  }
  if (CHEST.test(name)) return done([await chestQuads(atlas, name, props)]);

  const sets = await modelSets(assets, state);
  const tint = tintFor(name, props);
  const variants = [];
  for (const set of sets || []) {
    const q = [];
    let particle = null;
    for (const apply of set) {
      if (!apply || !apply.model) continue;
      const model = await assets.model(apply.model);
      particle ||= resolveTex(model.textures, '#particle');
      const rx = Number(apply.x) || 0, ry = Number(apply.y) || 0;
      for (const el of model.elements) {
        await addElement(q, atlas, el, (face) => {
          const ref = resolveTex(model.textures, face.texture);
          return ref ? atlas.texture(ref, face.tintindex !== undefined ? tint : undefined) : -1;
        }, rx, ry, !!apply.uvlock);
      }
    }
    // Модель без геометрії (її малює гра окремо, як шалкерову скриню): куб із текстурою частинок.
    if (!q.length && particle) {
      const layer = await atlas.texture(particle);
      if (layer >= 0) await addElement(q, atlas, { from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(DIR_NAMES.map((d) => [d, { cullface: d }])) }, () => layer);
    }
    variants.push(q);
  }
  const baked = done(variants);
  if (baked) return baked;
  // Блока немає у файлі гри (наприклад, із мода): кольоровий куб.
  const layer = await atlas.add('#color|' + name, () => colorTile(name).tiles[0]);
  const q = [];
  await addElement(q, atlas, { from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(DIR_NAMES.map((d) => [d, { cullface: d }])) }, () => layer);
  return done([q], { missing: true });
}

// Моделі всіх станів схематика для 3D і атлас їхніх текстур. onProgress(done, total) для рядка стану.
export async function bakeBlocks(assets, states, onProgress) {
  const atlas = new Atlas(assets);
  const blocks = new Array(states.length).fill(null);
  for (let i = 0; i < states.length; i++) {
    try {
      blocks[i] = await bakeState(atlas, states[i] || 'minecraft:air');
    } catch (e) {
      console.warn('Блок для 3D', states[i], e);
    }
    if (onProgress && (i % 16 === 0 || i === states.length - 1)) {
      onProgress(i + 1, states.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return { blocks, atlas: atlas.pack() };
}

// ---------- Файли гри запам’ятовуються в цьому браузері ----------
// Браузер не дає сайту знову відкрити файл за шляхом, тож вибраний .jar кладемо в IndexedDB
// цього браузера. Звідти він нікуди не йде, а наступного разу 3D одразу буде з текстурами.
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('city-site', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('packs');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('packs', mode);
      const req = fn(tx.objectStore('packs'));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
export const rememberPacks = (files) => idb('readwrite', (s) => s.put([...files], 'textures')).catch((e) => console.warn('Текстури не запам’яталися:', e));
export const rememberedPacks = () => idb('readonly', (s) => s.get('textures')).catch(() => null);
export const forgetPacks = () => idb('readwrite', (s) => s.delete('textures')).catch(() => {});
