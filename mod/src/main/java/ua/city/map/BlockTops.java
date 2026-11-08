package ua.city.map;

import com.mojang.blaze3d.platform.NativeImage;
import net.minecraft.client.Minecraft;
import net.minecraft.client.color.block.BlockTintSource;
import net.minecraft.client.model.geom.builders.UVPair;
import net.minecraft.client.renderer.block.FluidModel;
import net.minecraft.client.renderer.block.dispatch.BlockStateModel;
import net.minecraft.client.renderer.block.dispatch.BlockStateModelPart;
import net.minecraft.client.renderer.texture.SpriteContents;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.resources.model.ModelManager;
import net.minecraft.client.resources.model.geometry.BakedQuad;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.packs.resources.Resource;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.material.FluidState;
import org.joml.Vector3fc;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Плитка «вид згори» 16×16 для кожного стану блока, як на сайті (public/textures.js):
 * верхні грані моделі з текстурами, нижчі грані трохи темніші, рослини малюються своєю картинкою.
 * Працює в потоці гри: моделі й текстури беруться з того, що гра вже завантажила (разом із ресурспаками).
 */
final class BlockTops {
    static final int T = 16;
    private static final int MAX_VARIANTS = 16;
    private static final Direction[] DIRS = Direction.values();
    private static final BlockTintSource[] NO_TINTS = new BlockTintSource[0];
    // Те, що згори не видно або без моделі виглядало б дивно (як NO_TOP на сайті).
    private static final Pattern NO_TOP = Pattern.compile(
        "ladder|vine|lichen|sculk_vein|sign$|banner$|_button$|tripwire|lever$|_head$|_skull$|skull$|head$");
    private static final Set<String> EMPTY_NAMES = Set.of("structure_void", "light", "barrier", "moving_piston");

    /** Готова плитка: пікселі ARGB без відтінку і номер відтінку для кожного пікселя (-1 — без нього). */
    static final class Top {
        final int[] argb = new int[T * T];
        final byte[] tint = new byte[T * T];
        BlockTintSource[] tints = NO_TINTS;
        BlockState tintState;
        boolean opaque;
        boolean empty = true;

        Top() {
            java.util.Arrays.fill(tint, (byte) -1);
        }
    }

    static final Top EMPTY = new Top();

    private record Sprite(int w, int h, int[] px) {}

    private record Variant(BlockStateModelPart[] parts, Top top) {
        boolean matches(List<BlockStateModelPart> list) {
            if (list.size() != parts.length) return false;
            for (int i = 0; i < parts.length; i++) if (list.get(i) != parts[i]) return false;
            return true;
        }
    }

    private static final class Entry {
        final Top fixed;
        final BlockStateModel model;
        final boolean noTop;
        final List<Variant> variants = new ArrayList<>(2);

        Entry(Top fixed, BlockStateModel model, boolean noTop) {
            this.fixed = fixed;
            this.model = model;
            this.noTop = noTop;
        }
    }

    private record Face(BakedQuad quad, float h) {}

    private final Map<BlockState, Entry> entries = new IdentityHashMap<>();
    private final Map<FluidState, Top> fluids = new IdentityHashMap<>();
    private final Map<Identifier, Optional<Sprite>> sprites = new HashMap<>();
    private final RandomSource random = RandomSource.create(0);
    private final List<BlockStateModelPart> parts = new ArrayList<>();
    private Object modelSet;

    private static ModelManager models() {
        return Minecraft.getInstance().getModelManager();
    }

    /** Після перезавантаження ресурсів (F3+T, інший ресурспак) усе малюється заново. */
    void checkReload() {
        Object set = models().getBlockStateModelSet();
        if (set != modelSet) {
            modelSet = set;
            entries.clear();
            fluids.clear();
            sprites.clear();
        }
    }

    /** Плитка для блока в цій точці: варіант моделі вибирається так само, як у грі (за seed позиції). */
    Top top(BlockState st, BlockPos pos) {
        Entry e = entries.get(st);
        if (e == null) {
            e = makeEntry(st);
            entries.put(st, e);
        }
        if (e.fixed != null) return e.fixed;
        random.setSeed(st.getSeed(pos));
        parts.clear();
        e.model.collectParts(random, parts);
        for (Variant v : e.variants) if (v.matches(parts)) return v.top;
        if (e.variants.size() >= MAX_VARIANTS) return e.variants.get(0).top;
        Top t = buildModel(st, e.model, parts, e.noTop);
        e.variants.add(new Variant(parts.toArray(new BlockStateModelPart[0]), t));
        return t;
    }

    /** Вода чи лава: текстура спокійної рідини з відтінком біома (вода напівпрозора, тож видно дно). */
    Top fluidTop(FluidState fs) {
        Top cached = fluids.get(fs);
        if (cached != null) return cached;
        Top t = new Top();
        FluidModel fm = models().getFluidStateModelSet().get(fs);
        if (fm != null && fm.stillMaterial() != null) {
            BlockTintSource src = fm.tintSource();
            fullSprite(t, fm.stillMaterial().sprite(), src != null ? 0 : -1);
            if (src != null) t.tints = new BlockTintSource[] {src};
            t.tintState = fs.createLegacyBlock();
        }
        finish(t);
        fluids.put(fs, t);
        return t;
    }

    private Entry makeEntry(BlockState st) {
        Block b = st.getBlock();
        String path = BuiltInRegistries.BLOCK.getKey(b).getPath();
        if (st.isAir() || EMPTY_NAMES.contains(path)) return new Entry(EMPTY, null, true);
        if (b instanceof LiquidBlock) {
            FluidState fs = st.getFluidState();
            return new Entry(fs.isEmpty() ? EMPTY : fluidTop(fs), null, true);
        }
        Top chest = chestTop(st, path);
        if (chest != null) return new Entry(chest, null, true);
        // Невидимі блоки без блок-сутності (бар'єр, бульбашки у воді) згори не видно.
        if (st.getRenderShape() == RenderShape.INVISIBLE && !st.hasBlockEntity()) return new Entry(EMPTY, null, true);
        return new Entry(null, models().getBlockStateModelSet().get(st), NO_TOP.matcher(path).find());
    }

    private Top buildModel(BlockState st, BlockStateModel model, List<BlockStateModelPart> parts, boolean noTop) {
        Top t = new Top();
        List<Face> ups = new ArrayList<>();
        BakedQuad side = null;
        boolean any = false;
        for (BlockStateModelPart part : parts) {
            for (int d = 0; d <= DIRS.length; d++) {
                List<BakedQuad> quads = part.getQuads(d < DIRS.length ? DIRS[d] : null);
                for (BakedQuad q : quads) {
                    any = true;
                    Vector3fc p0 = q.position0(), p1 = q.position1(), p2 = q.position2(), p3 = q.position3();
                    float ax = p2.x() - p0.x(), ay = p2.y() - p0.y(), az = p2.z() - p0.z();
                    float bx = p3.x() - p1.x(), by = p3.y() - p1.y(), bz = p3.z() - p1.z();
                    float nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
                    float len = (float) Math.sqrt(nx * nx + ny * ny + nz * nz);
                    if (len < 1e-6f) continue;
                    Vector3fc dn = q.direction().getUnitVec3f();
                    if (nx * dn.x() + ny * dn.y() + nz * dn.z() < 0) ny = -ny;
                    float up = ny / len;
                    if (Math.abs(up) < 0.5f) {
                        if (side == null) side = q; // бокова грань: знадобиться рослинам
                        continue;
                    }
                    if (up < 0) continue;
                    float h = (p0.y() + p1.y() + p2.y() + p3.y()) / 4f * 16f;
                    ups.add(new Face(q, h));
                }
            }
        }
        if (!ups.isEmpty()) {
            ups.sort((a, b) -> Float.compare(a.h, b.h));
            float hmax = ups.get(ups.size() - 1).h;
            for (Face f : ups) {
                // Нижня сходинка помітно темніша за верхню, плита чи килим трохи темніші за повний блок.
                float dark = 0.3f * clamp01((hmax - f.h) / 16f) + 0.06f * clamp01(1f - f.h / 16f);
                raster(t, f.quad, dark);
            }
        } else if (side != null && !noTop) {
            // Квіти, посіви, ланцюги: згори малюємо їхню картинку, інакше їх не було б видно.
            fullSprite(t, side.materialInfo().sprite(), side.materialInfo().isTinted() ? side.materialInfo().tintIndex() : -1);
        } else if (!any && !noTop) {
            // Модель без геометрії (шалкерові скрині, горщики): текстура частинок.
            fullSprite(t, model.particleMaterial().sprite(), -1);
        }
        int maxTint = -1;
        for (byte b : t.tint) maxTint = Math.max(maxTint, b);
        if (maxTint >= 0) {
            t.tints = new BlockTintSource[maxTint + 1];
            for (int i = 0; i <= maxTint; i++) {
                try {
                    t.tints[i] = Minecraft.getInstance().getBlockColors().getTintSource(st, i);
                } catch (RuntimeException ignored) {
                    // без відтінку
                }
            }
            t.tintState = st;
        }
        finish(t);
        return t;
    }

    /** Малює верхню грань: пікселі плитки беруть колір з текстури за афінним відображенням кутів грані. */
    private void raster(Top t, BakedQuad q, float dark) {
        TextureAtlasSprite sp = q.materialInfo().sprite();
        Sprite img = sprite(sp);
        if (img == null) return;
        int tintIdx = q.materialInfo().isTinted() ? q.materialInfo().tintIndex() : -1;
        float[] sx = new float[4], sz = new float[4], u = new float[4], v = new float[4];
        for (int k = 0; k < 4; k++) {
            Vector3fc p = q.position(k);
            sx[k] = p.x() * 16f;
            sz[k] = p.z() * 16f;
            long uv = q.packedUV(k);
            u[k] = UVPair.unpackU(uv);
            v[k] = UVPair.unpackV(uv);
        }
        float u0 = sp.getU0(), u1 = sp.getU1(), v0 = sp.getV0(), v1 = sp.getV1();
        float eu = Math.abs(u1 - u0) * 0.02f + 1e-6f, ev = Math.abs(v1 - v0) * 0.02f + 1e-6f;
        boolean atlas = Math.abs(u1 - u0) > 1e-9f && Math.abs(v1 - v0) > 1e-9f;
        for (int k = 0; k < 4 && atlas; k++) {
            if (u[k] < Math.min(u0, u1) - eu || u[k] > Math.max(u0, u1) + eu
                || v[k] < Math.min(v0, v1) - ev || v[k] > Math.max(v0, v1) + ev) atlas = false;
        }
        for (int k = 0; k < 4; k++) {
            u[k] = atlas ? (u[k] - u0) / (u1 - u0) * img.w : u[k] * img.w;
            v[k] = atlas ? (v[k] - v0) / (v1 - v0) * img.h : v[k] * img.h;
        }
        float e1x = sx[1] - sx[0], e1z = sz[1] - sz[0], e3x = sx[3] - sx[0], e3z = sz[3] - sz[0];
        float det = e1x * e3z - e1z * e3x;
        if (Math.abs(det) < 1e-6f) return;
        float minX = Math.min(Math.min(sx[0], sx[1]), Math.min(sx[2], sx[3]));
        float maxX = Math.max(Math.max(sx[0], sx[1]), Math.max(sx[2], sx[3]));
        float minZ = Math.min(Math.min(sz[0], sz[1]), Math.min(sz[2], sz[3]));
        float maxZ = Math.max(Math.max(sz[0], sz[1]), Math.max(sz[2], sz[3]));
        int ix0 = Math.max(0, (int) Math.floor(minX)), ix1 = Math.min(T - 1, (int) Math.ceil(maxX) - 1);
        int iz0 = Math.max(0, (int) Math.floor(minZ)), iz1 = Math.min(T - 1, (int) Math.ceil(maxZ) - 1);
        for (int iz = iz0; iz <= iz1; iz++) {
            for (int ix = ix0; ix <= ix1; ix++) {
                float px = ix + 0.5f, pz = iz + 0.5f;
                if (!inside(sx, sz, px, pz)) continue;
                float dx = px - sx[0], dz = pz - sz[0];
                float a = (dx * e3z - dz * e3x) / det;
                float b = (e1x * dz - e1z * dx) / det;
                float uu = u[0] + a * (u[1] - u[0]) + b * (u[3] - u[0]);
                float vv = v[0] + a * (v[1] - v[0]) + b * (v[3] - v[0]);
                int tx = clamp((int) Math.floor(uu), 0, img.w - 1);
                int ty = clamp((int) Math.floor(vv), 0, img.h - 1);
                put(t, iz * T + ix, img.px[ty * img.w + tx], tintIdx, dark);
            }
        }
    }

    private static boolean inside(float[] x, float[] z, float px, float pz) {
        boolean pos = false, neg = false;
        for (int k = 0; k < 4; k++) {
            int n = (k + 1) & 3;
            float c = (x[n] - x[k]) * (pz - z[k]) - (z[n] - z[k]) * (px - x[k]);
            if (c > 1e-4f) pos = true;
            else if (c < -1e-4f) neg = true;
            if (pos && neg) return false;
        }
        return true;
    }

    /** Уся текстура на плитку 16×16 (для рослин, рідин і моделей без граней). */
    private void fullSprite(Top t, TextureAtlasSprite sp, int tintIdx) {
        Sprite img = sp == null ? null : sprite(sp);
        if (img == null) return;
        for (int iz = 0; iz < T; iz++) {
            int ty = Math.min(img.h - 1, (int) ((iz + 0.5f) * img.h / T));
            for (int ix = 0; ix < T; ix++) {
                int tx = Math.min(img.w - 1, (int) ((ix + 0.5f) * img.w / T));
                put(t, iz * T + ix, img.px[ty * img.w + tx], tintIdx, 0f);
            }
        }
    }

    // Скрині малює не модель, а блок-сутність: беремо кришку з текстури скрині, як на сайті.
    private Top chestTop(BlockState st, String path) {
        String p = path.startsWith("waxed_") ? path.substring(6) : path;
        String variant = switch (p) {
            case "chest" -> "normal";
            case "trapped_chest" -> "trapped";
            case "ender_chest" -> "ender";
            case "copper_chest" -> "copper";
            case "exposed_copper_chest" -> "copper_exposed";
            case "weathered_copper_chest" -> "copper_weathered";
            case "oxidized_copper_chest" -> "copper_oxidized";
            default -> null;
        };
        if (variant == null) return null;
        Sprite img = texture(Identifier.fromNamespaceAndPath("minecraft", "textures/entity/chest/" + variant + ".png"), 0, 0);
        if (img == null) img = texture(Identifier.fromNamespaceAndPath("minecraft", "textures/entity/chest/normal.png"), 0, 0);
        if (img == null) return null;
        int turn = 0;
        if (st.hasProperty(BlockStateProperties.HORIZONTAL_FACING)) {
            turn = switch (st.getValue(BlockStateProperties.HORIZONTAL_FACING)) {
                case EAST -> 1;
                case SOUTH -> 2;
                case WEST -> 3;
                default -> 0;
            };
        }
        float s = img.w / 64f;
        Top t = new Top();
        for (int dy = 0; dy < 14; dy++) {
            for (int dx = 0; dx < 14; dx++) {
                int sx = clamp((int) ((28 + dx + 0.5f) * s), 0, img.w - 1);
                int sy = clamp((int) ((dy + 0.5f) * s), 0, img.h - 1);
                int x = 1 + dx, y = 1 + dy;
                for (int r = 0; r < turn; r++) { // чверть оберту за годинниковою стрілкою
                    int nx = 15 - y;
                    y = x;
                    x = nx;
                }
                put(t, y * T + x, img.px[sy * img.w + sx], -1, 0f);
            }
        }
        finish(t);
        return t;
    }

    private static void put(Top t, int i, int c, int tintIdx, float dark) {
        int a = c >>> 24;
        if (a == 0) return;
        float k = 1f - dark;
        int r = Math.round(((c >> 16) & 255) * k), g = Math.round(((c >> 8) & 255) * k), b = Math.round((c & 255) * k);
        int d = t.argb[i];
        int da = d >>> 24;
        if (a == 255 || da == 0) {
            t.argb[i] = (a << 24) | (r << 16) | (g << 8) | b;
            t.tint[i] = (byte) tintIdx;
            return;
        }
        float sa = a / 255f, dw = da / 255f * (1f - sa), oa = sa + dw;
        int or = Math.round((r * sa + ((d >> 16) & 255) * dw) / oa);
        int og = Math.round((g * sa + ((d >> 8) & 255) * dw) / oa);
        int ob = Math.round((b * sa + (d & 255) * dw) / oa);
        t.argb[i] = (Math.round(oa * 255f) << 24) | (or << 16) | (og << 8) | ob;
        if (a >= 128) t.tint[i] = (byte) tintIdx;
    }

    private static void finish(Top t) {
        boolean opaque = true, empty = true;
        for (int c : t.argb) {
            int a = c >>> 24;
            if (a < 255) opaque = false;
            if (a > 0) empty = false;
        }
        t.opaque = opaque;
        t.empty = empty;
    }

    private Sprite sprite(TextureAtlasSprite sp) {
        SpriteContents c = sp.contents();
        Identifier name = c.name();
        return texture(name.withPath(p -> "textures/" + p + ".png"), c.width(), c.height());
    }

    /** Пікселі текстури (перший кадр анімації) з ресурсів гри, з урахуванням ресурспаків. */
    private Sprite texture(Identifier file, int frameW, int frameH) {
        Optional<Sprite> cached = sprites.get(file);
        if (cached != null) return cached.orElse(null);
        Sprite out = null;
        try {
            Optional<Resource> res = Minecraft.getInstance().getResourceManager().getResource(file);
            if (res.isPresent()) {
                try (InputStream in = res.get().open(); NativeImage img = NativeImage.read(in)) {
                    int w = frameW > 0 ? Math.min(frameW, img.getWidth()) : img.getWidth();
                    int h = frameH > 0 ? Math.min(frameH, img.getHeight()) : img.getHeight();
                    int[] px = new int[w * h];
                    for (int y = 0; y < h; y++) {
                        for (int x = 0; x < w; x++) px[y * w + x] = img.getPixel(x, y);
                    }
                    out = new Sprite(w, h, px);
                }
            }
        } catch (Exception e) {
            CityMapClient.LOG.debug("Текстура {}: {}", file, e.toString());
        }
        sprites.put(file, Optional.ofNullable(out));
        return out;
    }

    static float clamp01(float v) {
        return v < 0 ? 0 : v > 1 ? 1 : v;
    }

    static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : v > hi ? hi : v;
    }
}
