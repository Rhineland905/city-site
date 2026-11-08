// Чтение схематиков в браузере: .schem (Sponge v2/v3) и .litematic.
// Возвращает { width, height, length, blocks, palette, states }, где
// индекс блока = x + z*width + y*width*length, а blocks[i] — номер в palette.
// palette — имена блоков без свойств (minecraft:oak_stairs), states — полные состояния
// (minecraft:oak_stairs[facing=east,half=bottom,...]) для текстур.
import { blockColor, isSeeThrough, isNatural, isAir } from './blocks.js';

const MAX_VOLUME = 150_000_000; // больше браузер обычно не вытягивает по памяти

async function gunzip(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer; // не сжат
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

// Минимальный парсер NBT (big-endian, Java Edition).
// Массив long возвращается как Uint32Array пар [младшие 32 бита, старшие 32 бита].
function readNbt(buffer) {
  const view = new DataView(buffer);
  const dec = new TextDecoder();
  let p = 0;
  const str = () => {
    const len = view.getUint16(p); p += 2;
    const s = dec.decode(new Uint8Array(buffer, p, len)); p += len;
    return s;
  };
  const payload = (type) => {
    switch (type) {
      case 1: return view.getInt8(p++);
      case 2: { const v = view.getInt16(p); p += 2; return v; }
      case 3: { const v = view.getInt32(p); p += 4; return v; }
      case 4: { const v = view.getBigInt64(p); p += 8; return v; }
      case 5: { const v = view.getFloat32(p); p += 4; return v; }
      case 6: { const v = view.getFloat64(p); p += 8; return v; }
      case 7: { const n = view.getInt32(p); p += 4; const v = new Uint8Array(buffer.slice(p, p + n)); p += n; return v; }
      case 8: return str();
      case 9: {
        const t = view.getInt8(p++); const n = view.getInt32(p); p += 4;
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = payload(t);
        return out;
      }
      case 10: {
        const obj = {};
        for (;;) {
          const t = view.getInt8(p++);
          if (t === 0) return obj;
          const name = str();
          obj[name] = payload(t);
        }
      }
      case 11: {
        const n = view.getInt32(p); p += 4; const v = new Int32Array(n);
        for (let i = 0; i < n; i++) { v[i] = view.getInt32(p); p += 4; }
        return v;
      }
      case 12: {
        const n = view.getInt32(p); p += 4; const v = new Uint32Array(n * 2);
        for (let i = 0; i < n; i++) { v[i * 2 + 1] = view.getUint32(p); v[i * 2] = view.getUint32(p + 4); p += 8; }
        return v;
      }
      default: throw new Error('Невідомий тег NBT ' + type);
    }
  };
  const rootType = view.getInt8(p++);
  if (rootType !== 10) throw new Error('Файл не схожий на NBT');
  str();
  return payload(10);
}

const baseName = (state) => state.replace(/\[.*$/, '');

function allocBlocks(width, height, length) {
  const total = width * height * length;
  if (!total) throw new Error('Порожній схематик');
  if (total > MAX_VOLUME) throw new Error('Схематик завеликий для браузера, розділи його на частини');
  return new Uint16Array(total);
}

function parseSponge(root) {
  const s = root.Schematic && root.Schematic.Width !== undefined ? root.Schematic : root;
  const width = s.Width & 0xffff, height = s.Height & 0xffff, length = s.Length & 0xffff;
  const container = s.Blocks || s; // v3 хранит блоки в Blocks
  const paletteObj = container.Palette;
  const data = container.Data || container.BlockData;
  if (!paletteObj || !data) throw new Error('У схематику немає блоків');
  const palette = [], states = [];
  for (const [state, idx] of Object.entries(paletteObj)) { palette[idx] = baseName(state); states[idx] = state; }
  if (palette.length > 65535) throw new Error('Забагато різних блоків');
  const blocks = allocBlocks(width, height, length);
  // Номера блоков записаны как varint.
  const total = blocks.length;
  let i = 0, p = 0;
  while (i < total && p < data.length) {
    let value = 0, shift = 0, b;
    do { b = data[p++]; value |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    blocks[i++] = value;
  }
  return { width, height, length, blocks, palette, states };
}

function parseLitematic(root) {
  const regions = Object.values(root.Regions || {});
  if (!regions.length) throw new Error('У litematic немає регіонів');
  // Общая рамка всех регионов (размер может быть отрицательным).
  const boxes = regions.map((r) => {
    const pos = r.Position, size = r.Size;
    const lo = (p, s) => Math.min(p, p + s + (s < 0 ? 1 : -1));
    return {
      r, x0: lo(pos.x, size.x), y0: lo(pos.y, size.y), z0: lo(pos.z, size.z),
      sx: Math.abs(size.x), sy: Math.abs(size.y), sz: Math.abs(size.z),
    };
  });
  const minX = Math.min(...boxes.map((b) => b.x0));
  const minY = Math.min(...boxes.map((b) => b.y0));
  const minZ = Math.min(...boxes.map((b) => b.z0));
  const width = Math.max(...boxes.map((b) => b.x0 + b.sx)) - minX;
  const height = Math.max(...boxes.map((b) => b.y0 + b.sy)) - minY;
  const length = Math.max(...boxes.map((b) => b.z0 + b.sz)) - minZ;

  const palette = ['minecraft:air'], states = ['minecraft:air'];
  const paletteIndex = new Map([['minecraft:air', 0]]);
  const blocks = allocBlocks(width, height, length);

  for (const b of boxes) {
    const pal = (b.r.BlockStatePalette || []).map((e) => {
      const props = Object.entries(e.Properties || {}).sort(([a], [b]) => (a < b ? -1 : 1));
      const state = props.length ? `${e.Name}[${props.map(([k, v]) => `${k}=${v}`).join(',')}]` : e.Name;
      if (!paletteIndex.has(state)) { paletteIndex.set(state, palette.length); palette.push(e.Name); states.push(state); }
      return paletteIndex.get(state);
    });
    const words = b.r.BlockStates; // поток бит, младшие биты первыми
    if (!words || !pal.length) continue;
    const bits = Math.max(2, Math.ceil(Math.log2(pal.length)));
    const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
    const sx = b.sx, sxz = b.sx * b.sz;
    const dx = b.x0 - minX, dy = b.y0 - minY, dz = b.z0 - minZ;
    const count = sxz * b.sy;
    for (let i = 0; i < count; i++) {
      const pos = i * bits;
      const w = Math.floor(pos / 32), o = pos % 32;
      let v = words[w] >>> o;
      if (o + bits > 32) v |= words[w + 1] << (32 - o);
      const id = pal[(v & mask) >>> 0];
      if (!id) continue;
      const x = i % sx, z = Math.floor(i / sx) % b.sz, y = Math.floor(i / sxz);
      blocks[(dx + x) + (dz + z) * width + (dy + y) * width * length] = id;
    }
  }
  if (palette.length > 65535) throw new Error('Забагато різних блоків');
  return { width, height, length, blocks, palette, states };
}

export async function parseSchematic(buffer, fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  const root = readNbt(await gunzip(buffer));
  if (ext === 'litematic' || root.Regions) return parseLitematic(root);
  if (ext === 'schem' || root.Schematic || root.Palette) return parseSponge(root);
  throw new Error('Підтримуються лише .schem і .litematic');
}

// Какая доля непустых блоков — природная порода (для подземных построек это обычно больше половины).
export function naturalShare(schem) {
  const counts = new Uint32Array(schem.palette.length);
  for (let i = 0; i < schem.blocks.length; i++) counts[schem.blocks[i]]++;
  let solid = 0, natural = 0;
  schem.palette.forEach((n, i) => {
    if (isAir(n)) return;
    solid += counts[i];
    if (isNatural(n)) natural += counts[i];
  });
  return solid ? natural / solid : 0;
}

// Карта сверху: для каждого столбца берём верхний непрозрачный блок не выше topY.
// topY и bottomY считаются от низа схематика (0 = нижний слой).
// Рельеф подсвечивается как на картах в игре: выше соседа сверху — светлее, ниже — темнее.
export function renderTopDown(schem, { topY = schem.height - 1, bottomY = 0 } = {}) {
  const { width: W, length: L, blocks, palette } = schem;
  const WL = W * L;
  const see = palette.map(isSeeThrough);
  const rgb = palette.map((n) => blockColor(n || 'minecraft:air'));
  const top = Math.min(topY, schem.height - 1), bottom = Math.max(0, bottomY);
  const heights = new Int16Array(WL).fill(-1);
  const ids = new Uint16Array(WL);
  for (let z = 0; z < L; z++) {
    for (let x = 0; x < W; x++) {
      const col = x + z * W;
      for (let y = top; y >= bottom; y--) {
        const b = blocks[col + y * WL];
        if (!see[b]) { heights[col] = y; ids[col] = b; break; }
      }
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = L;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, L);
  const range = Math.max(1, top - bottom);
  for (let col = 0; col < WL; col++) {
    const h = heights[col];
    if (h < 0) continue; // пусто: останется прозрачным
    const north = col >= W ? heights[col - W] : h;
    let shade = 0.7 + 0.3 * ((h - bottom) / range); // глубже — темнее
    if (north >= 0 && h > north) shade *= 1.12;
    else if (north >= 0 && h < north) shade *= 0.82;
    const c = rgb[ids[col]];
    const o = col * 4;
    img.data[o] = Math.min(255, ((c >> 16) & 255) * shade);
    img.data[o + 1] = Math.min(255, ((c >> 8) & 255) * shade);
    img.data[o + 2] = Math.min(255, (c & 255) * shade);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Зріз за замовчуванням: висоти, де стоять збудовані (не природні) блоки.
// Для підземного міста це від підлоги до верху найвищих будинків, без скелі над печерою.
export function suggestSlice(schem) {
  const { width: W, height: H, length: L, blocks, palette } = schem;
  const built = palette.map((n) => !isAir(n) && !isNatural(n));
  const WL = W * L;
  const counts = new Uint32Array(H);
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let i = y * WL, end = i + WL; i < end; i++) if (built[blocks[i]]) c++;
    counts[y] = c;
  }
  const max = Math.max(...counts);
  if (!max) return null;
  const enough = (y) => counts[y] >= max * 0.01;
  let top = H - 1, bottom = 0;
  while (top > 0 && !enough(top)) top--;
  while (bottom < top && !enough(bottom)) bottom++;
  return { top, bottom: Math.max(0, bottom - 1) }; // на шар нижче, щоб підлога точно потрапила
}
