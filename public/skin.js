// Скіни жителів: плоска фігура спереду для карток і 3D-модель гравця для профілю.
// Формат скіна стандартний для Minecraft: PNG 64×64 (або старий 64×32), тонкі руки (Alex) визначаються самі.

// Де на скіні лежить кожна частина тіла: [u, v] основного шару й шару зверху (капюшон, куртка тощо).
const PARTS = {
  head: { size: [8, 8, 8], base: [0, 0], over: [32, 0] },
  body: { size: [8, 12, 4], base: [16, 16], over: [16, 32] },
  rArm: { size: [4, 12, 4], base: [40, 16], over: [40, 32] },
  lArm: { size: [4, 12, 4], base: [32, 48], over: [48, 48] },
  rLeg: { size: [4, 12, 4], base: [0, 16], over: [0, 32] },
  lLeg: { size: [4, 12, 4], base: [16, 48], over: [0, 48] },
};

export function loadImage(url) {
  return new Promise((done, fail) => {
    const img = new Image();
    img.onload = () => done(img);
    img.onerror = () => fail(new Error('скін не завантажився'));
    img.src = url;
  });
}

// Будь-який скін → полотно 64×64. Старий 64×32 не має лівої руки й ноги: копіюємо праві.
export function normalize(img) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0);
  if (img.height === 32) {
    g.drawImage(c, 0, 16, 16, 16, 16, 48, 16, 16);  // права нога → ліва
    g.drawImage(c, 40, 16, 16, 16, 32, 48, 16, 16); // права рука → ліва
  }
  return c;
}

// Тонкі руки: у скіна Alex задні 2 стовпчики смуги руки порожні.
export function isSlim(c) {
  const d = c.getContext('2d').getImageData(54, 20, 2, 12).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
  return true;
}

// Плоска фігура спереду 16×32 пікселів скіна, збільшена в scale разів без розмиття.
export function drawFront(skin, scale = 6) {
  const slim = isSlim(skin);
  const aw = slim ? 3 : 4;
  const out = document.createElement('canvas');
  out.width = 16 * scale; out.height = 32 * scale;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = false;
  const face = (part, layer, x, y, w = PARTS[part].size[0]) => {
    const { size: [, h, d] } = PARTS[part];
    const [u, v] = PARTS[part][layer];
    g.drawImage(skin, u + d, v + d, w, h, x * scale, y * scale, w * scale, h * scale);
  };
  for (const layer of ['base', 'over']) {
    face('rLeg', layer, 4, 20); face('lLeg', layer, 8, 20);
    face('body', layer, 4, 8);
    face('rArm', layer, 4 - aw, 8, aw); face('lArm', layer, 12, 8, aw);
    face('head', layer, 4, 0);
  }
  return out;
}

// Голова (обличчя з капюшоном) для маленьких аватарок.
export function drawHead(skin, scale = 8) {
  const out = document.createElement('canvas');
  out.width = out.height = 8 * scale;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(skin, 8, 8, 8, 8, 0, 0, 8 * scale, 8 * scale);
  g.drawImage(skin, 40, 8, 8, 8, 0, 0, 8 * scale, 8 * scale);
  return out;
}

// ---------- 3D ----------
// Модель гравця з шести коробок (і шару зверху трохи більшого розміру), повільно крутиться й дихає.
export async function createSkinViewer(container, skin) {
  const THREE = await import('three');
  const { OrbitControls } = await import('./vendor/three/OrbitControls.js');
  const slim = isSlim(skin);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 400);
  camera.position.set(22, 22, 58);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 16, 0);
  controls.enablePan = false;
  controls.minDistance = 28; controls.maxDistance = 110;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.autoRotate = !still;
  controls.autoRotateSpeed = 1.6;
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(30, 50, 40);
  scene.add(sun);
  const glow = new THREE.PointLight(0x22e1e3, 600, 120); // відблиск скалку знизу
  glow.position.set(0, -6, 14);
  scene.add(glow);

  const tex = new THREE.CanvasTexture(skin);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const baseMat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5 });
  const overMat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide });

  // Розкладка граней на скіні: [права][перед][ліва][зад] і над ними верх і низ.
  function box(part, layer, w) {
    const [pw, h, d] = PARTS[part].size;
    const bw = w ?? pw;
    const [u, v] = PARTS[part][layer];
    const grow = layer === 'over' ? (part === 'head' ? 1 : 0.5) : 0;
    const geo = new THREE.BoxGeometry(bw + grow, h + grow, d + grow);
    const rects = [ // порядок граней BoxGeometry: +x, −x, +y, −y, +z, −z
      [u + d + bw, v + d, d, h],          // ліва сторона гравця
      [u, v + d, d, h],                   // права
      [u + d, v, bw, d],                  // верх
      [u + d + bw, v, bw, d, true],       // низ (перевернутий)
      [u + d, v + d, bw, h],              // перед
      [u + d + bw + d, v + d, bw, h],     // зад
    ];
    const uv = geo.attributes.uv;
    rects.forEach(([x, y, rw, rh, flip], f) => {
      const x0 = x / 64, x1 = (x + rw) / 64;
      let y0 = 1 - y / 64, y1 = 1 - (y + rh) / 64;
      if (flip) [y0, y1] = [y1, y0];
      const i = f * 4;
      uv.setXY(i, x0, y0); uv.setXY(i + 1, x1, y0); uv.setXY(i + 2, x0, y1); uv.setXY(i + 3, x1, y1);
    });
    return new THREE.Mesh(geo, layer === 'over' ? overMat : baseMat);
  }
  // Частина тіла з точкою обертання (плече, стегно) і зсувом коробки від неї.
  function limb(part, pivot, offset, w) {
    const g = new THREE.Group();
    g.position.set(...pivot);
    for (const layer of ['base', 'over']) {
      const m = box(part, layer, w);
      m.position.set(...offset);
      g.add(m);
    }
    return g;
  }
  const aw = slim ? 3 : 4;
  const player = new THREE.Group();
  const head = limb('head', [0, 24, 0], [0, 4, 0]);
  const body = limb('body', [0, 18, 0], [0, 0, 0]);
  const rArm = limb('rArm', [-4 - aw / 2, 22, 0], [0, -4, 0], aw);
  const lArm = limb('lArm', [4 + aw / 2, 22, 0], [0, -4, 0], aw);
  const rLeg = limb('rLeg', [-2, 12, 0], [0, -6, 0]);
  const lLeg = limb('lLeg', [2, 12, 0], [0, -6, 0]);
  player.add(head, body, rArm, lArm, rLeg, lLeg);
  scene.add(player);

  // Плитка скалку під ногами.
  const floor = new THREE.Mesh(
    new THREE.CylinderGeometry(11, 11, 0.6, 32),
    new THREE.MeshLambertMaterial({ color: 0x0b2a2f, emissive: 0x06363a }),
  );
  floor.position.y = -0.3;
  scene.add(floor);

  function resize() {
    const w = container.clientWidth || 300, h = container.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  let raf = 0;
  const t0 = performance.now();
  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (!still) {
      const t = (performance.now() - t0) / 1000;
      const s = Math.sin(t * 1.4) * 0.12;
      rArm.rotation.x = s; lArm.rotation.x = -s;
      rArm.rotation.z = -0.05 - Math.abs(s) * 0.15; lArm.rotation.z = 0.05 + Math.abs(s) * 0.15;
      head.rotation.y = Math.sin(t * 0.5) * 0.25;
      head.rotation.x = Math.sin(t * 0.7) * 0.06;
    }
    controls.update();
    renderer.render(scene, camera);
  };
  frame();

  return {
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => o.geometry?.dispose());
      baseMat.dispose(); overMat.dispose(); tex.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
