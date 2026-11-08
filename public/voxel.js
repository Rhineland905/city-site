// 3D-просмотр схематиков и всего города (three.js).
// Сплошные блоки собираются в одну сетку, рисуются только видимые грани.
// Свет фонарей и свечей рисуется мягкими точками, как в Глубокой тьме.
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { blockColor, isAir, isNatural } from './blocks.js';

// ---------- Форма блоков ----------
const SKIP = /^(air|cave_air|void_air|light|barrier|structure_void|bubble_column|moving_piston|tripwire|tripwire_hook|string|cobweb|vine|glow_lichen|sculk_vein|ladder|lever|scaffolding|rail|powered_rail|detector_rail|activator_rail|redstone_wire|frogspawn|piston_head|.*_button|.*_sign|.*_banner|.*_pressure_plate|.*_coral_fan|.*_coral_wall_fan|.*hanging_sign)$/;
const EMISSIVE = /^(glowstone|sea_lantern|shroomlight|.*froglight|.*copper_bulb|redstone_lamp|jack_o_lantern|lava|magma_block|beacon|crying_obsidian|respawn_anchor)$/;
const SMALL_LIGHT = /(lantern|torch|candle|campfire|fire|end_rod)$/;
const TRANSLUCENT = /(glass|^ice|^water$|nether_portal|honey_block|slime_block)$/;
const FLAT = /(carpet|repeater|comparator|daylight_detector|lily_pad|trapdoor)$|^snow$/;
const SLAB = /_slab$/;
const POST = /(fence|_wall|iron_bars|_pane|chain|lightning_rod)$/;
const SMALL = /(sapling|flower|tulip|orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|poppy|dandelion|torchflower|pitcher_plant|mushroom|fungus|roots|sprouts|wheat|carrots|potatoes|beetroots|_stem|sweet_berry_bush|sugar_cane|bamboo|short_grass|tall_grass|fern|dead_bush|seagrass|kelp|kelp_plant|skull|head|flower_pot|potted_\w+|brewing_stand|bell|pointed_dripstone|amethyst_cluster|amethyst_bud|cocoa|nether_wart|turtle_egg|sea_pickle|cake)$/;

const K = { skip: 0, full: 1, emissive: 2, translucent: 3, box: 4, light: 5 };
function classify(name, hideNatural) {
  if (isAir(name) || (hideNatural && isNatural(name))) return { k: K.skip };
  const n = name.replace(/^minecraft:/, '');
  if (SKIP.test(n)) return { k: K.skip };
  if (EMISSIVE.test(n)) return { k: K.emissive };
  if (SMALL_LIGHT.test(n)) return { k: K.light, box: [0.3, 0.5, 0.3] };
  if (TRANSLUCENT.test(n)) return { k: K.translucent };
  if (FLAT.test(n)) return { k: K.box, box: [1, 0.12, 1] };
  if (SLAB.test(n)) return { k: K.box, box: [1, 0.5, 1] };
  if (POST.test(n)) return { k: K.box, box: [0.3, 1, 0.3] };
  if (SMALL.test(n)) return { k: K.box, box: [0.45, 0.55, 0.45] };
  return { k: K.full };
}

function lightColor(n) {
  if (/soul|sculk/.test(n)) return 0x3ff3ff; // бирюзовый огонь душ
  if (/candle/.test(n)) return 0xffc670;
  if (/end_rod/.test(n)) return 0xf4f0ff;
  return 0xffb347;
}

// ---------- Сборка сетки ----------
class Buf {
  constructor(n = 1 << 16) { this.a = new Float32Array(n); this.n = 0; }
  push3(x, y, z) {
    if (this.n + 3 > this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
  get() { return this.a.subarray(0, this.n); }
}

// Грани: нормаль и две оси, u × v = нормаль (обход против часовой стрелки снаружи).
const FACES = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], d: [1, 0, 0], shade: 0.68 },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], d: [-1, 0, 0], shade: 0.68 },
  { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0], d: [0, 1, 0], shade: 1.0 },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], d: [0, -1, 0], shade: 0.5 },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], d: [0, 0, 1], shade: 0.82 },
  { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0], d: [0, 0, -1], shade: 0.82 },
];

class MeshBuilder {
  constructor() { this.pos = new Buf(); this.col = new Buf(); this.verts = 0; }
  // Грань коробки с центром c и половинными размерами h.
  face(f, cx, cy, cz, hx, hy, hz, r, g, b) {
    const hu = f.u[0] * hx + f.u[1] * hy + f.u[2] * hz; // половина размера вдоль u
    const hv = f.v[0] * hx + f.v[1] * hy + f.v[2] * hz;
    const fx = cx + f.n[0] * hx, fy = cy + f.n[1] * hy, fz = cz + f.n[2] * hz;
    const ux = f.u[0] * hu, uy = f.u[1] * hu, uz = f.u[2] * hu;
    const vx = f.v[0] * hv, vy = f.v[1] * hv, vz = f.v[2] * hv;
    this.pos.push3(fx - ux - vx, fy - uy - vy, fz - uz - vz);
    this.pos.push3(fx + ux - vx, fy + uy - vy, fz + uz - vz);
    this.pos.push3(fx + ux + vx, fy + uy + vy, fz + uz + vz);
    this.pos.push3(fx - ux + vx, fy - uy + vy, fz - uz + vz);
    for (let i = 0; i < 4; i++) this.col.push3(r, g, b);
    this.verts += 4;
  }
  build(material) {
    if (!this.verts) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos.get().slice(), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col.get().slice(), 3));
    const quads = this.verts / 4;
    const idx = new Uint32Array(quads * 6);
    for (let q = 0, v = 0, o = 0; q < quads; q++, v += 4) {
      idx[o++] = v; idx[o++] = v + 1; idx[o++] = v + 2;
      idx[o++] = v; idx[o++] = v + 2; idx[o++] = v + 3;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return new THREE.Mesh(geo, material);
  }
}

// Небольшая «зернистость», чтобы стены не были плоскими, как текстура блоков.
const grain = (x, y, z) => {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return 0.9 + 0.1 * (((h ^ (h >>> 16)) >>> 0) / 4294967295);
};

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// colors: средние цвета блоков из текстур игры { 'minecraft:grass_block': ['#верх', '#бок'] }.
// Без них цвета берутся из таблицы в blocks.js.
export function buildModel(schem, { hideNatural = false, clippingPlanes = [], colors = null } = {}) {
  const { width: W, height: H, length: L, blocks, palette } = schem;
  const WL = W * L;
  const cls = palette.map((n) => classify(n || 'minecraft:air', hideNatural));
  // THREE.Color переводит цвет из sRGB в линейное пространство, иначе всё выглядит выцветшим.
  const lift = (v) => Math.min(1, v * 1.3 + 0.02); // тёмный deepslate иначе сливается с фоном
  const toRgb = (hex) => {
    const c = new THREE.Color().setHex(hex);
    return [lift(c.r), lift(c.g), lift(c.b)];
  };
  const rgbTop = [], rgbSide = [];
  palette.forEach((n, i) => {
    const pair = colors && colors[n];
    if (pair) {
      rgbTop[i] = toRgb(parseInt(pair[0].slice(1), 16));
      rgbSide[i] = toRgb(parseInt(pair[1].slice(1), 16));
    } else {
      rgbTop[i] = rgbSide[i] = toRgb(blockColor(n || 'minecraft:air'));
    }
  });
  const lights = palette.map((n) => new THREE.Color(lightColor(n || '')));
  const occludes = cls.map((c) => c.k === K.full || c.k === K.emissive);
  const isTrans = cls.map((c) => c.k === K.translucent);

  const solid = new MeshBuilder();
  const glass = new MeshBuilder();
  const glowPos = new Buf(1024), glowCol = new Buf(1024);
  let faces = 0;

  for (let y = 0; y < H; y++) {
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        const i = x + z * W + y * WL;
        const id = blocks[i];
        const c = cls[id];
        if (c.k === K.skip) continue;
        if (c.k === K.full || c.k === K.emissive || c.k === K.translucent) {
          const target = c.k === K.translucent ? glass : solid;
          const k = c.k === K.emissive ? 1.15 : grain(x, y, z);
          for (const f of FACES) {
            const nx = x + f.d[0], ny = y + f.d[1], nz = z + f.d[2];
            let draw = true;
            if (nx >= 0 && ny >= 0 && nz >= 0 && nx < W && ny < H && nz < L) {
              const nb = blocks[nx + nz * W + ny * WL];
              draw = !occludes[nb] && !(c.k === K.translucent && nb === id);
            }
            if (!draw) continue;
            const s = c.k === K.emissive ? k : f.shade * k;
            const [r, g, b] = f.n[1] === 1 ? rgbTop[id] : rgbSide[id];
            target.face(f, x + 0.5, y + 0.5, z + 0.5, 0.5, 0.5, 0.5, r * s, g * s, b * s);
            faces++;
          }
        } else {
          // Неполные блоки: плиты, ковры, столбы, растения и фонари стоят на полу клетки.
          const [bx, by, bz] = c.box;
          const cy = y + by / 2;
          const k = c.k === K.light ? 1.2 : grain(x, y, z);
          for (const f of FACES) {
            const s = c.k === K.light ? k : f.shade * k;
            const [r, g, b] = f.n[1] === 1 ? rgbTop[id] : rgbSide[id];
            solid.face(f, x + 0.5, cy, z + 0.5, bx / 2, by / 2, bz / 2, r * s, g * s, b * s);
            faces++;
          }
          if (c.k === K.light) {
            glowPos.push3(x + 0.5, y + 0.6, z + 0.5);
            const lc = lights[id];
            glowCol.push3(lc.r, lc.g, lc.b);
          }
        }
      }
    }
  }

  const group = new THREE.Group();
  const solidMesh = solid.build(new THREE.MeshBasicMaterial({ vertexColors: true, clippingPlanes }));
  if (solidMesh) group.add(solidMesh);
  const glassMesh = glass.build(new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false, clippingPlanes,
  }));
  if (glassMesh) group.add(glassMesh);
  if (glowPos.n) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(glowPos.get().slice(), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(glowCol.get().slice(), 3));
    group.add(new THREE.Points(geo, new THREE.PointsMaterial({
      size: 3.2, map: glowTexture(), vertexColors: true, transparent: true, opacity: 0.75,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, clippingPlanes,
    })));
  }
  return { group, faces, size: { x: W, y: H, z: L } };
}

function disposeGroup(group) {
  group.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}

// ---------- Просмотрщик ----------
export function createViewer(container, { fog = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);
  const overlay = document.createElement('div');
  overlay.className = 'v3d-labels';
  container.appendChild(overlay);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.screenSpacePanning = true;
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);

  let model = null;
  let markers = [];
  const markerGroup = new THREE.Group();
  scene.add(markerGroup);
  let onPick = null;

  function frame(size) {
    const r = Math.max(size.x, size.y, size.z, 12);
    controls.target.set(size.x / 2, size.y * 0.35, size.z / 2);
    camera.position.set(size.x / 2 + r * 0.8, size.y * 0.35 + r * 0.75, size.z / 2 + r * 1.0);
    camera.near = Math.max(0.1, r / 2000);
    camera.far = r * 12;
    camera.updateProjectionMatrix();
    controls.maxDistance = r * 4;
    if (fog) scene.fog = new THREE.Fog(0x04080a, r * 0.9, r * 3.2);
    controls.update();
  }

  const api = {
    setModel(schem, opts = {}) {
      const keepView = !!model && opts.keepView;
      if (model) { scene.remove(model.group); disposeGroup(model.group); }
      model = buildModel(schem, { ...opts, clippingPlanes: [clipPlane] });
      scene.add(model.group);
      if (!keepView) frame(model.size);
      return model;
    },
    // Всё, что выше этой высоты (в координатах модели), скрывается.
    setClip(y) { clipPlane.constant = y; },
    setMarkers(list, pick) {
      onPick = pick;
      markerGroup.children.slice().forEach((m) => { markerGroup.remove(m); disposeGroup(m); });
      overlay.innerHTML = '';
      markers = list.map((m) => {
        const g = new THREE.Group();
        g.position.set(m.x + 0.5, m.y + 0.5, m.z + 0.5);
        const core = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshBasicMaterial({ color: 0x22e1e3 }));
        const beam = new THREE.Mesh(
          new THREE.BoxGeometry(0.18, 10, 0.18),
          new THREE.MeshBasicMaterial({ color: 0x22e1e3, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        beam.position.y = 5;
        const hit = new THREE.Mesh(new THREE.BoxGeometry(2.4, 12, 2.4), new THREE.MeshBasicMaterial({ visible: false }));
        hit.position.y = 5;
        hit.userData.id = m.id;
        g.add(core, beam, hit);
        markerGroup.add(g);
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'v3d-label';
        label.textContent = m.label;
        label.addEventListener('click', () => onPick?.(m.id));
        overlay.appendChild(label);
        return { ...m, group: g, core, hit, label };
      });
    },
    resize,
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      if (model) disposeGroup(model.group);
      disposeGroup(markerGroup);
      renderer.dispose();
      renderer.domElement.remove();
      overlay.remove();
    },
  };

  // Клик по метке открывает схематик (если мышь почти не сдвинулась).
  const ray = new THREE.Raycaster();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || !markers.length) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    ), camera);
    const hit = ray.intersectObjects(markers.map((m) => m.hit))[0];
    if (hit) onPick?.(hit.object.userData.id);
  });

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  let raf = 0, alive = true;
  const v = new THREE.Vector3();
  const loop = (t) => {
    if (!alive) return;
    if (!container.clientWidth) { raf = requestAnimationFrame(loop); return; } // вкладка скрыта
    controls.update();
    // Метки пульсируют, как сердце вардена.
    const beat = 1 + 0.25 * Math.max(0, Math.sin(t / 180)) * Math.max(0, Math.sin(t / 900));
    const w = container.clientWidth, h = container.clientHeight;
    for (const m of markers) {
      m.core.scale.setScalar(beat);
      const hidden = m.y + 0.5 > clipPlane.constant;
      m.group.visible = !hidden;
      v.copy(m.group.position).add({ x: 0, y: 1.6, z: 0 }).project(camera);
      const show = !hidden && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      m.label.hidden = !show;
      if (show) m.label.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return api;
}
