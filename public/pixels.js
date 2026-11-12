// Піксельні текстури блоків без файлів гри.
// Коли в браузері немає .jar (телефон, чужий комп’ютер), 3D однаково має виглядати як Minecraft:
// кожен блок отримує власний квадрат 16×16, який сайт малює сам за типом блока (камінь, цегла, дошки,
// колоди, руди, скло…) і його середнім кольором. Жодного пікселя з текстур Mojang тут немає.
// Результат має той самий вигляд, що й bakeBlocks у textures.js, тож 3D малює його тим самим шляхом
// (voxel.js → buildTextured): з відсіканням граней, тінями в кутах і атласом-стосом.
import { blockColor, isAir } from './blocks.js';

const S = 16; // пікселів у текстурі, як у грі
const QUAD = 24;
// Сторони в порядку textures.js: верх низ північ південь захід схід.
const DIRS = [[0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const SHADE = [1, 0.5, 0.8, 0.8, 0.6, 0.6]; // світло на гранях, як у грі

// ---------- Випадковість із зерном: той самий блок завжди має той самий малюнок ----------
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Плавний шум: випадкова сітка cell×cell, розтягнута на 16 пікселів і загорнута по краях,
// щоб сусідні блоки стикувалися без шва.
function smooth(r, cell) {
  const n = S / cell, g = Array.from({ length: n * n }, () => r() * 2 - 1);
  const at = (x, y) => g[((y + n) % n) * n + ((x + n) % n)];
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = x / cell - 0.5, fy = y / cell - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const a = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const b = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      out[y * S + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

// Полотно: яскравість кожного пікселя відносно середнього кольору, прозорість і, де треба, свій колір.
class Tile {
  constructor(rgb, seed) {
    this.rgb = rgb;
    this.r = rng(seed);
    this.k = new Float32Array(S * S).fill(1);
    this.a = new Uint8Array(S * S).fill(255);
    this.c = new Array(S * S).fill(null);
  }
  noise(amount, cell = 1) {
    const n = cell > 1 ? smooth(this.r, cell) : null;
    for (let i = 0; i < S * S; i++) this.k[i] *= 1 + amount * (n ? n[i] : this.r() * 2 - 1);
    return this;
  }
  mul(x, y, k) { if (x >= 0 && y >= 0 && x < S && y < S) this.k[y * S + x] *= k; }
  set(x, y, rgb, k = 1) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    this.c[y * S + x] = rgb;
    this.k[y * S + x] = k;
  }
  // RGBA для атласу. Яскравість нормуємо, щоб середній колір лишався таким, як у таблиці.
  pixels() {
    let sum = 0, n = 0;
    for (let i = 0; i < S * S; i++) if (!this.c[i] && this.a[i]) { sum += this.k[i]; n++; }
    const norm = n ? n / sum : 1;
    const out = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      const c = this.c[i] || this.rgb, k = this.c[i] ? this.k[i] : this.k[i] * norm;
      out[i * 4] = Math.max(0, Math.min(255, c[0] * k));
      out[i * 4 + 1] = Math.max(0, Math.min(255, c[1] * k));
      out[i * 4 + 2] = Math.max(0, Math.min(255, c[2] * k));
      out[i * 4 + 3] = this.a[i];
    }
    return out;
  }
}

const rgbOf = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

// ---------- Малюнки ----------
// Камінь: великі плями й дрібне зерно.
const stone = (t) => t.noise(0.12, 4).noise(0.08, 2).noise(0.06);
// Глибинний сланець: горизонтальні смуги.
function deepslate(t, top) {
  t.noise(0.07);
  if (top) return t.noise(0.12, 4);
  const rows = Array.from({ length: S }, () => 1 + (t.r() * 2 - 1) * 0.14);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) t.k[y * S + x] *= rows[y] * (1 + (t.r() < 0.06 ? -0.2 : 0));
  return t;
}
// Пісок, борошно бетону, сніг: дрібне рівне зерно.
const fine = (t, a = 0.08) => t.noise(a).noise(a * 0.6, 2);
// Земля: зерно з темними й світлими цятками.
function dirt(t) {
  t.noise(0.1, 2).noise(0.1);
  for (let i = 0; i < 18; i++) t.mul((t.r() * S) | 0, (t.r() * S) | 0, t.r() < 0.6 ? 0.72 : 1.22);
  return t;
}
// Комірки Вороного: бруківка, гравій, глибинна бруківка.
function cells(t, count, gap, spread) {
  const pts = Array.from({ length: count }, () => [t.r() * S, t.r() * S, 1 + (t.r() * 2 - 1) * spread]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let d1 = 1e9, d2 = 1e9, k = 1;
      for (const [px, py, pk] of pts) {
        for (let ox = -S; ox <= S; ox += S) {
          for (let oy = -S; oy <= S; oy += S) {
            const d = (x + 0.5 - px - ox) ** 2 + (y + 0.5 - py - oy) ** 2;
            if (d < d1) { d2 = d1; d1 = d; k = pk; } else if (d < d2) d2 = d;
          }
        }
      }
      const edge = Math.sqrt(d2) - Math.sqrt(d1);
      t.k[y * S + x] *= edge < gap ? 0.62 : k * (edge < gap + 1 ? 0.9 : 1.06);
    }
  }
  return t.noise(0.06);
}
// Цегла: ряди висотою h і цеглини завширшки w зі зсувом через ряд; шви темні, верхній край світліший.
function bricks(t, h, w, base = 0.08) {
  t.noise(base).noise(0.05, 2);
  const rowK = Array.from({ length: S / h }, () => Array.from({ length: S / w + 1 }, () => 1 + (t.r() * 2 - 1) * 0.08));
  for (let y = 0; y < S; y++) {
    const row = (y / h) | 0, off = row % 2 ? w / 2 : 0;
    for (let x = 0; x < S; x++) {
      const bx = Math.floor((x + off) / w), lx = (x + off) % w, ly = y % h;
      let k = rowK[row][bx % rowK[row].length];
      if (ly === h - 1 || lx === w - 1) k *= 0.6;
      else if (ly === 0 || lx === 0) k *= 1.1;
      t.k[y * S + x] *= k;
    }
  }
  return t;
}
// Плитка: квадрати size×size.
function tiles(t, size) {
  t.noise(0.07);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const lx = x % size, ly = y % size;
      t.k[y * S + x] *= lx === size - 1 || ly === size - 1 ? 0.6 : lx === 0 || ly === 0 ? 1.12 : 1;
    }
  }
  return t;
}
// Дошки: чотири смуги по 4 пікселі зі швами, стики дощок у різних місцях, волокна вздовж.
function planks(t) {
  for (let y = 0; y < S; y++) {
    const board = (y / 4) | 0, ly = y % 4, joint = (board * 7 + 3) % S;
    for (let x = 0; x < S; x++) {
      let k = 1 + (t.r() * 2 - 1) * 0.05 + (board % 2 ? -0.04 : 0.03);
      if (ly === 3) k *= 0.62;
      else if (ly === 0) k *= 1.08;
      if (x === joint) k *= 0.7;
      t.k[y * S + x] *= k;
    }
  }
  for (let i = 0; i < 6; i++) { // волокна
    const y = (t.r() * S) | 0, x0 = (t.r() * S) | 0, len = 3 + ((t.r() * 5) | 0);
    for (let x = x0; x < x0 + len; x++) t.mul(x % S, y, 0.86);
  }
  return t;
}
// Кора: вертикальні борозни.
function bark(t) {
  const cols = Array.from({ length: S }, () => 1 + (t.r() * 2 - 1) * 0.2);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) t.k[y * S + x] *= cols[x] * (1 + (t.r() * 2 - 1) * 0.06);
  for (let i = 0; i < 10; i++) {
    const x = (t.r() * S) | 0, y0 = (t.r() * S) | 0, len = 2 + ((t.r() * 4) | 0);
    for (let y = y0; y < y0 + len; y++) t.mul(x, y % S, 0.7);
  }
  return t;
}
// Зріз колоди: кільця всередині й кора по краю.
function rings(t, barkRgb) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const edge = Math.min(x, y, S - 1 - x, S - 1 - y);
      if (edge === 0 && barkRgb) { t.set(x, y, barkRgb, 0.9 + t.r() * 0.15); continue; }
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      t.k[y * S + x] *= (Math.round(d) % 3 === 0 ? 0.84 : 1.04) * (1 + (t.r() * 2 - 1) * 0.04);
    }
  }
  return t;
}
// Полірований, гладкий, різаний камінь і металеві блоки: майже рівні, з фаскою по краю.
function polished(t, bevel = 1, amount = 0.04) {
  t.noise(amount).noise(amount, 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (x < bevel || y < bevel) t.k[y * S + x] *= 1.12;
      else if (x >= S - bevel || y >= S - bevel) t.k[y * S + x] *= 0.74;
    }
  }
  return t;
}
// Вовна й килими: дрібне переплетення.
function wool(t) {
  t.noise(0.05);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if ((x + y * 3) % 4 === 0) t.k[y * S + x] *= 0.92;
  return t;
}
// Листя: шум із дірками.
function leaves(t) {
  t.noise(0.18).noise(0.14, 2);
  for (let i = 0; i < S * S; i++) if (t.r() < 0.18) t.a[i] = 0;
  return t;
}
// Скло: світла рамка й пара відблисків, усередині прозоро (кольорове скло — напівпрозоре).
function glass(t, tinted) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x, edge = x === 0 || y === 0 || x === S - 1 || y === S - 1;
      if (edge) { t.k[i] = 1.25; continue; }
      const streak = (x === y + 3 && x < 7) || (x === y + 5 && x > 9 && x < 13) || (x + 1 === y && x > 3 && x < 6);
      if (streak) { t.k[i] = 1.35; t.a[i] = tinted ? 200 : 170; continue; }
      t.a[i] = tinted ? 120 : 0;
    }
  }
  return t;
}
// Вода й лава: хвилясті смуги.
function liquid(t, alpha) {
  const ph = t.r() * 6;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const w = Math.sin((x + Math.sin((y + ph) * 0.9) * 2) * 0.8 + y * 0.35);
      t.k[y * S + x] *= 1 + w * 0.12 + (t.r() * 2 - 1) * 0.04;
      t.a[y * S + x] = alpha;
    }
  }
  return t;
}
// Цятки на камені: руди, скалк, світлокамінь. colorOf(i) дає колір цятки.
function specks(t, count, colorOf, size = 3) {
  for (let i = 0; i < count; i++) {
    const cx = 1 + ((t.r() * (S - 3)) | 0), cy = 1 + ((t.r() * (S - 3)) | 0);
    const n = 2 + ((t.r() * size) | 0);
    let x = cx, y = cy;
    for (let j = 0; j < n; j++) {
      const c = colorOf(i);
      t.set(x, y, c, j === 0 ? 1.15 : 0.85 + t.r() * 0.2);
      if (t.r() < 0.5) x += t.r() < 0.5 ? 1 : -1; else y += t.r() < 0.5 ? 1 : -1;
    }
  }
  return t;
}
// Книжкова полиця: два ряди корінців між дошками.
function bookshelf(t, wood) {
  const BOOKS = [[150, 40, 40], [50, 70, 150], [60, 120, 50], [150, 110, 40], [100, 55, 30], [120, 60, 140]];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const shelf = y === 0 || y === 7 || y === 8 || y === 15 || x === 0 || x === 15;
      if (shelf) { t.set(x, y, wood, y === 7 || y === 15 ? 0.7 : 1); continue; }
      const book = ((x + (y > 7 ? 1 : 0)) / 2) | 0;
      const c = BOOKS[(book * 5 + (y > 7 ? 3 : 0)) % BOOKS.length];
      t.set(x, y, c, x % 2 ? 0.8 : 1 + (y % 7 === 1 ? 0.15 : 0));
    }
  }
  return t;
}
// Світні блоки: яскраві плями.
const glow = (t) => t.noise(0.16, 4).noise(0.1);
// Лампа (морський ліхтар, мідна лампа, лампа редстоуну): рамка й світле ядро.
function lamp(t) {
  t.noise(0.08);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const e = Math.min(x, y, S - 1 - x, S - 1 - y);
      t.k[y * S + x] *= e < 2 ? 0.75 : e < 3 ? 0.9 : 1.15;
    }
  }
  return t;
}
// Трава збоку: земля із зеленою смугою зверху, що звисає неоднаково.
function grassSide(t, green) {
  dirt(t);
  for (let x = 0; x < S; x++) {
    const h = 2 + ((t.r() * 3) | 0);
    for (let y = 0; y < h; y++) t.set(x, y, green, 0.85 + t.r() * 0.3);
  }
  return t;
}

const ORE = {
  coal: [[40, 40, 40]], iron: [[216, 175, 147], [180, 140, 110]], copper: [[200, 110, 75], [90, 170, 130]],
  gold: [[250, 230, 70], [200, 160, 30]], redstone: [[230, 20, 20], [150, 0, 0]], lapis: [[40, 80, 200], [25, 50, 140]],
  diamond: [[100, 235, 225], [40, 180, 170]], emerald: [[60, 220, 110], [20, 150, 60]],
  quartz: [[235, 230, 220]], nether_gold: [[250, 220, 60]],
};
const WOOD = /^(stripped_)?(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)(?=_|$)/;
const PLANK_LIKE = /_(planks|stairs|slab|fence|fence_gate|door|trapdoor|pressure_plate|button|sign|wall_sign|hanging_sign)$/;
const WOODEN = /^(crafting_table|barrel|chest|trapped_chest|composter|lectern|cartography_table|fletching_table|smithing_table|loom|note_block|jukebox|beehive|bee_nest)$/;

// Матеріал блока без «сходинки», «плити», «стіни»: deepslate_brick_stairs → deepslate_brick.
const material = (n) => n.replace(/_(stairs|slab|wall|fence|fence_gate|pressure_plate|button)$/, '');

// Текстура грані. face: 'top' | 'side' | 'bottom'. rgb — середній колір цієї грані.
// Повертає { key, kind, make } — make() малює RGBA лише раз на ключ.
function tileFor(name, face, rgb) {
  const n = name.replace(/^minecraft:/, '');
  const m = material(n);
  const key = (p) => `${p}|${face}|${rgb.join(',')}|${m}`;
  const T = (p, kind, draw) => ({ key: key(p), kind, make: () => { const t = new Tile(rgb, hashStr(key(p))); draw(t); return t.pixels(); } });

  if (/^(water|bubble_column)$/.test(n)) return T('water', 2, (t) => liquid(t, 170));
  if (n === 'lava') return T('lava', 0, (t) => liquid(t.noise(0.15, 4), 255));
  if (/stained_glass/.test(n)) return T('glass', 2, (t) => glass(t, true));
  if (/glass/.test(n)) return T('glass', 1, (t) => glass(t, false));
  if (/^ice$|frosted_ice/.test(n)) return T('ice', 2, (t) => liquid(t.noise(0.05), 200));
  if (/leaves/.test(n)) return T('leaves', 1, leaves);
  if (n === 'grass_block') {
    if (face === 'top') return T('grass', 0, (t) => t.noise(0.14).noise(0.08, 2));
    if (face === 'bottom') return { key: 'dirt|plain', kind: 0, make: () => dirt(new Tile([134, 96, 67], 7)).pixels() };
    return { key: key('grassside'), kind: 0, make: () => grassSide(new Tile([134, 96, 67], hashStr(key('gs'))), [106, 156, 62]).pixels() };
  }
  const ore = m.match(/^(deepslate_|nether_)?(\w+?)_ore$/);
  if (ore) {
    const deep = ore[1] === 'deepslate_', nether = ore[1] === 'nether_' || m === 'nether_quartz_ore';
    const base = deep ? [77, 77, 82] : nether ? [110, 50, 50] : [125, 125, 125];
    const cols = ORE[nether && ore[2] === 'gold' ? 'nether_gold' : ore[2]] || [[200, 200, 200]];
    return { key: key('ore'), kind: 0, make: () => {
      const t = new Tile(base, hashStr(key('ore')));
      (deep ? deepslate(t, face !== 'side') : stone(t));
      specks(t, 5, (i) => cols[i % cols.length]);
      return t.pixels();
    } };
  }
  if (/^sculk(_catalyst|_shrieker|_sensor)?$/.test(m)) {
    return T('sculk', 0, (t) => specks(t.noise(0.15, 2).noise(0.1), 6, () => [40, 230, 235], 2));
  }
  if (m === 'bookshelf' || m === 'chiseled_bookshelf') {
    if (face !== 'side') return T('planks', 0, planks);
    return { key: key('books'), kind: 0, make: () => bookshelf(new Tile(rgb, hashStr(key('books'))), [160, 128, 78]).pixels() };
  }
  const wood = m.match(WOOD);
  if (wood && /_(log|wood|stem|hyphae)$|^bamboo_block$|^stripped_bamboo_block$/.test(m)) {
    const allBark = /_(wood|hyphae)$/.test(m);
    if (face !== 'side' && !allBark) return T('rings', 0, (t) => rings(t, null));
    return T(/^stripped_/.test(m) ? 'stripped' : 'bark', 0, /^stripped_/.test(m) ? (t) => t.noise(0.05).noise(0.08, 2) : bark);
  }
  if ((wood && PLANK_LIKE.test(n)) || /_planks$/.test(m) || WOODEN.test(n)) {
    return T('planks', 0, planks);
  }
  if (/cobble/.test(m)) return T('cobble', 0, (t) => cells(t, 11, 0.7, 0.14));
  if (/^gravel$|^suspicious_gravel$/.test(m)) return T('gravel', 0, (t) => cells(t, 18, 0.45, 0.25));
  if (/^(stone_brick|stone_bricks|mossy_stone_brick|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks|infested_stone_bricks)$/.test(m)) {
    return T('stonebricks', 0, (t) => bricks(t, 8, 16, 0.07));
  }
  if (/^(bricks?|brick)$/.test(m)) return T('bricks', 0, (t) => bricks(t, 4, 8, 0.12));
  if (/tiles?$/.test(m)) return T('tiles', 0, (t) => tiles(t, /deepslate/.test(m) ? 4 : 8));
  if (/bricks?$/.test(m)) return T('smallbricks', 0, (t) => bricks(t, 4, 8, 0.08));
  if (/^(deepslate|infested_deepslate|reinforced_deepslate)$/.test(m)) return T('deepslate', 0, (t) => deepslate(t, face !== 'side'));
  if (/concrete$/.test(m) && !/powder/.test(m)) return T('concrete', 0, (t) => t.noise(0.025));
  if (/terracotta/.test(m)) return T('terracotta', 0, (t) => t.noise(0.05).noise(0.04, 4));
  if (/polished|smooth|^cut_|_cut_|chiseled|quartz|purpur|^(iron|gold|diamond|emerald|lapis|netherite|copper|exposed_copper|weathered_copper|oxidized_copper|waxed_\w+|redstone|coal)_block$|copper$|_pillar$/.test(m)) {
    return T('polished', 0, (t) => polished(t, 1, /quartz|smooth/.test(m) ? 0.025 : 0.045));
  }
  if (/wool|carpet/.test(m)) return T('wool', 0, wool);
  if (/glowstone|shroomlight|magma/.test(m)) return T('glow', 0, glow);
  if (/sea_lantern|froglight|copper_bulb|redstone_lamp|jack_o_lantern|beacon/.test(m)) return T('lamp', 0, lamp);
  if (/lantern|torch|candle|campfire|end_rod/.test(m)) return T('light', 0, (t) => t.noise(0.1));
  if (/^(sand|red_sand|snow|snow_block|powder_snow|white_concrete_powder|\w+_concrete_powder|clay|calcite)$/.test(m)) return T('fine', 0, (t) => fine(t));
  if (/^(dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|farmland|dirt_path|soul_soil|soul_sand)$/.test(m)) return T('dirt', 0, dirt);
  if (/sandstone/.test(m)) return T('sandstone', 0, (t) => (face === 'side' ? t.noise(0.05).noise(0.08, 4) : polished(t, 1, 0.04)));
  if (/obsidian/.test(m)) return T('obsidian', 0, (t) => specks(t.noise(0.18, 4).noise(0.1), 4, () => scale(rgb, 1.9), 2));
  if (/netherrack|nylium/.test(m)) return T('netherrack', 0, (t) => t.noise(0.2).noise(0.12, 2));
  if (/amethyst/.test(m)) return T('amethyst', 0, (t) => cells(t, 6, 0.5, 0.2));
  if (/moss/.test(m)) return T('moss', 0, (t) => t.noise(0.16).noise(0.1, 2));
  if (/blackstone|basalt|tuff|andesite|diorite|granite|stone|end_stone|dripstone|bedrock|prismarine/.test(m)) return T('stone', 0, stone);
  return T('generic', 0, (t) => t.noise(0.08).noise(0.08, 4));
}


// ---------- Відкритий ресурспак ----------
// public/pack/blocks.png — текстури Pixel Perfection CE і VoxeLibre (CC BY-SA, автори в public/pack/CREDITS.md),
// зібрані scripts/build-open-pack.py. Вони вільні для поширення, тож лежать на сайті й працюють у всіх,
// навіть на телефоні. Чого в паку немає, малюємо самі (малюнки вище).
let packPromise = null;
export function loadOpenPack() {
  packPromise ??= (async () => {
    const [meta, img] = await Promise.all([
      fetch('/pack/blocks.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))),
      new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = '/pack/blocks.png'; }),
    ]);
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const all = g.getImageData(0, 0, c.width, c.height).data;
    const size = meta.size, tiles = new Map();
    for (const [name, [i, tint]] of Object.entries(meta.tiles)) {
      const ox = (i % meta.cols) * size, oy = Math.floor(i / meta.cols) * size;
      const px = new Uint8Array(S * S * 4);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const sp = ((oy + y) * c.width + ox + x) * 4, dp = (y * S + x) * 4;
        px[dp] = all[sp]; px[dp + 1] = all[sp + 1]; px[dp + 2] = all[sp + 2]; px[dp + 3] = all[sp + 3];
      }
      tiles.set(name, { px, tint: !!tint });
    }
    return tiles;
  })().catch((e) => { console.warn('Відкритий ресурспак не завантажився:', e); packPromise = null; return null; });
  return packPromise;
}

// Колір біому для сірих текстур (як рівнини в грі).
function tintOf(tex) {
  if (/^water/.test(tex)) return [63, 118, 228];
  if (/^birch_leaves/.test(tex)) return [128, 167, 85];
  if (/^spruce_leaves/.test(tex)) return [97, 153, 97];
  if (/leaves|vine|lily_pad/.test(tex)) return [119, 171, 47];
  return [145, 189, 89]; // трава
}

// Яку текстуру паку взяти для грані блока. Повертає ім'я текстури або null.
const SPECIES = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)$/;
function packBase(n) {
  let b = n.replace(/^(waxed_|infested_)/, '');
  let m;
  if ((m = b.match(/^(\w+?)_(door)$/))) return SPECIES.test(m[1]) || m[1] === 'iron' ? `${m[1]}_door_bottom` : null;
  if ((m = b.match(/^(\w+?)_trapdoor$/))) return `${m[1]}_trapdoor`;
  b = b.replace(/_(stairs|slab|wall|fence_gate|fence|pressure_plate|button)$/, '');
  if (SPECIES.test(b)) return b === 'bamboo' ? 'bamboo_planks' : `${b}_planks`;
  if (b === 'petrified_oak') return 'oak_planks';
  if ((m = b.match(/^(stripped_)?(\w+)_wood$/))) return `${m[1] || ''}${m[2]}_log`;
  if ((m = b.match(/^(stripped_)?(\w+)_hyphae$/))) return `${m[1] || ''}${m[2]}_stem`;
  if (/_carpet$/.test(b)) return b === 'moss_carpet' ? 'moss_block' : b.replace(/_carpet$/, '_wool');
  if (/_pane$/.test(b)) return b.replace(/_pane$/, '');
  const MAP = {
    quartz: 'quartz_block', smooth_quartz: 'quartz_block_bottom', smooth_sandstone: 'sandstone_top',
    smooth_red_sandstone: 'red_sandstone_top', brick: 'bricks', purpur: 'purpur_block', snow_block: 'snow',
    water: 'water_still', bubble_column: 'water_still', lava: 'lava_still', dirt_path: 'dirt_path', grass_path: 'grass_path',
  };
  if (MAP[b]) return MAP[b];
  if (/_brick$/.test(b)) return b + 's';
  if (/_tile$/.test(b)) return b + 's';
  return b;
}

function packTile(n, face, pack) {
  if (!pack || /lantern|torch|candle|campfire|end_rod|chain$/.test(n)) return null; // у паку це розгортки моделей, не квадрати
  const base = packBase(n);
  if (!base) return null;
  const pick = (...names) => names.find((x) => pack.has(x));
  let tex;
  if (face === 'top') tex = pick(`${base}_top`, `${base}_end`, base, `${base}_side`);
  else if (face === 'bottom') tex = pick(`${base}_bottom`, `${base}_top`, `${base}_end`, base, `${base}_side`);
  else tex = pick(`${base}_side`, `${base}_front`, base);
  if (!tex && /_planks$/.test(base)) return null;
  if (!tex) return null;
  const overlay = n === 'grass_block' && face === 'side' ? pack.get('grass_block_side_overlay') : null;
  // Бокові грані колод, стовпів і т. п. — як є; для колоди без _side беремо саму колоду.
  return {
    key: `pack|${tex}`, kind: null,
    make: () => {
      const t = pack.get(tex), px = t.px.slice();
      if (/^water/.test(tex)) for (let k = 3; k < px.length; k += 4) px[k] = Math.min(px[k], 180);
      if (t.tint) { const c = tintOf(tex); for (let k = 0; k < px.length; k += 4) { px[k] = px[k] * c[0] / 255; px[k + 1] = px[k + 1] * c[1] / 255; px[k + 2] = px[k + 2] * c[2] / 255; } }
      if (overlay) {
        const c = tintOf('grass'), o = overlay.px;
        for (let k = 0; k < px.length; k += 4) {
          if (o[k + 3] < 128) continue;
          const f = overlay.tint ? c : [255, 255, 255];
          px[k] = o[k] * f[0] / 255; px[k + 1] = o[k + 1] * f[1] / 255; px[k + 2] = o[k + 2] * f[2] / 255; px[k + 3] = 255;
        }
      }
      return px;
    },
  };
}

// Вид за прозорістю: 0 непрозорий, 1 з дірками, 2 напівпрозорий (як alphaKind у textures.js).
function alphaKind(px) {
  let clear = 0, semi = 0;
  for (let k = 3; k < px.length; k += 4) { if (px[k] === 0) clear++; else if (px[k] < 255) semi++; }
  return semi > (px.length / 4) * 0.15 ? 2 : clear + semi ? 1 : 0;
}

// ---------- Форма блоків ----------
// Неповні блоки — коробки в клітинці 1×1×1: [x0, y0, z0, x1, y1, z1].
const SKIP = /^(air|cave_air|void_air|light|barrier|structure_void|moving_piston|tripwire|tripwire_hook|string|cobweb|vine|glow_lichen|sculk_vein|ladder|lever|rail|powered_rail|detector_rail|activator_rail|redstone_wire|frogspawn|.*_sign|.*_banner|.*_head|.*_skull|.*_coral_fan|.*_coral_wall_fan|.*_button)$/;
const SMALL = /(sapling|flower|tulip|orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|poppy|dandelion|torchflower|pitcher_plant|mushroom|fungus|roots|sprouts|wheat|carrots|potatoes|beetroots|_stem|sweet_berry_bush|sugar_cane|bamboo|short_grass|tall_grass|fern|dead_bush|seagrass|kelp|kelp_plant|flower_pot|potted_\w+|brewing_stand|bell|pointed_dripstone|amethyst_cluster|amethyst_bud|cocoa|nether_wart|turtle_egg|sea_pickle|cake)$/;

function props(state) {
  const o = {};
  const m = /\[(.*)\]/.exec(state || '');
  if (m) for (const kv of m[1].split(',')) { const [k, v] = kv.split('='); o[k] = v; }
  return o;
}

function shapeBoxes(n, p) {
  if (/_stairs$/.test(n)) {
    const top = p.half === 'top';
    const step = top ? [0, 0, 0, 1, 0.5, 1] : [0, 0.5, 0, 1, 1, 1];
    const half = { north: [0, 0, 0, 1, 1, 0.5], south: [0, 0, 0.5, 1, 1, 1], west: [0, 0, 0, 0.5, 1, 1], east: [0.5, 0, 0, 1, 1, 1] }[p.facing] || [0, 0, 0, 1, 1, 0.5];
    const slab = top ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1];
    return [slab, [half[0], step[1], half[2], half[3], step[4], half[5]]];
  }
  if (/_slab$/.test(n)) return p.type === 'double' ? null : p.type === 'top' ? [[0, 0.5, 0, 1, 1, 1]] : [[0, 0, 0, 1, 0.5, 1]];
  if (/carpet$|^snow$|repeater|comparator|daylight_detector|lily_pad|pressure_plate/.test(n)) return [[0, 0, 0, 1, n === 'snow' ? 0.125 * (Number(p.layers) || 1) : 0.0625, 1]];
  if (/trapdoor$/.test(n)) {
    if (p.open === 'true') {
      const d = { north: [0, 0, 0.8125, 1, 1, 1], south: [0, 0, 0, 1, 1, 0.1875], west: [0.8125, 0, 0, 1, 1, 1], east: [0, 0, 0, 0.1875, 1, 1] }[p.facing];
      return [d || [0, 0, 0, 1, 1, 0.1875]];
    }
    return [p.half === 'top' ? [0, 0.8125, 0, 1, 1, 1] : [0, 0, 0, 1, 0.1875, 1]];
  }
  if (/_door$/.test(n)) {
    const d = { north: [0, 0, 0.8125, 1, 1, 1], south: [0, 0, 0, 1, 1, 0.1875], west: [0.8125, 0, 0, 1, 1, 1], east: [0, 0, 0, 0.1875, 1, 1] }[p.facing];
    return [d || [0, 0, 0, 1, 1, 0.1875]];
  }
  if (/(fence|_wall|iron_bars|_pane|chain|lightning_rod|end_rod)$/.test(n)) {
    const on = (v) => v && v !== 'false' && v !== 'none';
    const sides = ['north', 'south', 'west', 'east'].filter((d) => on(p[d]));
    // Рука від стовпа до краю клітинки в бік d, товщиною 2t, на висоті y0…y1.
    const arm = (d, t, y0, y1) => ({
      north: [0.5 - t, y0, 0, 0.5 + t, y1, 0.5], south: [0.5 - t, y0, 0.5, 0.5 + t, y1, 1],
      west: [0, y0, 0.5 - t, 0.5, y1, 0.5 + t], east: [0.5, y0, 0.5 - t, 1, y1, 0.5 + t],
    }[d]);
    const post = (w, h = 1) => [0.5 - w, 0, 0.5 - w, 0.5 + w, h, 0.5 + w];
    if (/_wall$/.test(n)) {
      const boxes = [post(0.25)];
      for (const d of sides) boxes.push(arm(d, 0.1875, 0, p[d] === 'tall' ? 1 : 0.875));
      return boxes;
    }
    if (/fence$/.test(n)) {
      const boxes = [post(0.125)];
      for (const d of sides) boxes.push(arm(d, 0.0625, 0.375, 0.5625), arm(d, 0.0625, 0.75, 0.9375));
      return boxes;
    }
    if (/(iron_bars|_pane)$/.test(n)) {
      const boxes = [post(0.0625)];
      for (const d of sides) boxes.push(arm(d, 0.0625, 0, 1));
      return boxes;
    }
    return [post(0.09375)];
  }
  if (/lantern$/.test(n)) return [[0.3125, p.hanging === 'true' ? 0.0625 : 0, 0.3125, 0.6875, p.hanging === 'true' ? 0.5 : 0.4375, 0.6875]];
  if (/torch$|candle$/.test(n)) return [[0.4375, 0, 0.4375, 0.5625, 0.625, 0.5625]];
  if (/campfire$/.test(n)) return [[0, 0, 0, 1, 0.4375, 1]];
  if (SMALL.test(n)) return [[0.25, 0, 0.25, 0.75, 0.6, 0.75]];
  if (/^(water|bubble_column|lava)$/.test(n)) return [[0, 0, 0, 1, 1, 1]];
  return null; // повний куб
}

// Чотирикутники коробки у форматі textures.js (кути проти годинникової стрілки ззовні).
// uv беремо з положення в клітинці, як «uvlock» у грі: половина плити — половина текстури.
function pushBox(out, b, layers, kinds) {
  const [x0, y0, z0, x1, y1, z1] = b;
  const corners = [
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], // верх
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], // низ
    [[x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0]], // північ
    [[x0, y1, z1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1]], // південь
    [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], // захід
    [[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]], // схід
  ];
  const uvOf = [
    (p) => [p[0], p[2]], (p) => [p[0], 1 - p[2]], (p) => [1 - p[0], 1 - p[1]],
    (p) => [p[0], 1 - p[1]], (p) => [p[2], 1 - p[1]], (p) => [1 - p[2], 1 - p[1]],
  ];
  const onEdge = [y1 >= 1, y0 <= 0, z0 <= 0, z1 >= 1, x0 <= 0, x1 >= 1];
  for (let d = 0; d < 6; d++) {
    const pts = corners[d];
    for (const p of pts) out.push(p[0], p[1], p[2]);
    for (const p of pts) out.push(...uvOf[d](p));
    const face = d === 0 ? 0 : d === 1 ? 2 : 1;
    out.push(layers[face], onEdge[d] ? d : -1, SHADE[d], kinds[face]);
  }
}

// Які сторони клітинки закриті цілком: непрозорими гранями й будь-якими (як shapeOf у textures.js).
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

// Стани блоків схематика → { blocks, atlas, pixels: true } як у bakeBlocks.
// colors — середні кольори з /api/colors ({ ім’я: ['#верх', '#бік'] }), інакше таблиця з blocks.js.
// pack — текстури відкритого ресурспаку (loadOpenPack) або null.
export function pixelBlocks(states, colors = null, pack = null) {
  const index = new Map(), list = [];
  const layer = (t) => {
    let i = index.get(t.key);
    if (i === undefined) { i = list.length; list.push(t); index.set(t.key, i); }
    return i;
  };
  const byName = new Map(), made = new Map();
  const blocks = states.map((state) => {
    const name = (state || 'minecraft:air').replace(/\[.*$/, '');
    const n = name.replace(/^minecraft:/, '');
    if (isAir(name) || SKIP.test(n)) return null;
    const p = props(state);
    const boxes = shapeBoxes(n, p);
    const shapeKey = `${name}|${JSON.stringify(boxes)}`;
    if (byName.has(shapeKey)) return byName.get(shapeKey);
    const pair = colors && colors[name];
    const hexTop = pair ? parseInt(pair[0].slice(1), 16) : blockColor(name);
    const hexSide = pair ? parseInt(pair[1].slice(1), 16) : hexTop;
    const tex = (face, rgb) => {
      const t = packTile(n, face, pack);
      if (!t) return tileFor(name, face, rgb);
      let px = made.get(t.key);
      if (!px) { px = t.make(); made.set(t.key, px); }
      return { key: t.key, kind: /^(water|bubble_column)$/.test(n) ? 2 : alphaKind(px), make: () => px };
    };
    const top = tex('top', rgbOf(hexTop));
    const side = tex('side', rgbOf(hexSide));
    const bottom = tex('bottom', rgbOf(hexTop));
    const tl = [layer(top), layer(side), layer(bottom)];
    const kinds = [top.kind, side.kind, bottom.kind];
    const q = [];
    for (const b of boxes || [[0, 0, 0, 1, 1, 1]]) pushBox(q, b, tl, kinds);
    const list32 = Float32Array.from(q);
    const { solid, full } = shapeOf(list32);
    const group = /^(water|bubble_column)$/.test(n) ? 'minecraft:water' : name;
    const baked = { variants: [list32], solid: solid === 63, full: full === 63, solidMask: solid, group };
    byName.set(shapeKey, baked);
    return baked;
  });
  const data = new Uint8Array(S * S * 4 * Math.max(1, list.length));
  list.forEach((t, i) => {
    const px = t.make();
    // Прозорим пікселям даємо середній колір, щоб здалеку не було чорної облямівки.
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = 0; k < px.length; k += 4) if (px[k + 3]) { r += px[k]; g += px[k + 1]; b += px[k + 2]; n++; }
    if (n && n < px.length / 4) for (let k = 0; k < px.length; k += 4) if (!px[k + 3]) { px[k] = r / n; px[k + 1] = g / n; px[k + 2] = b / n; }
    data.set(px, i * S * S * 4);
  });
  return { blocks, atlas: { size: S, count: Math.max(1, list.length), data }, pixels: true };
}

