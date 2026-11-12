package ua.city.map;

import net.minecraft.client.color.block.BlockTintSource;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.level.material.FluidState;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Малює чанк згори між двома висотами (зріз), так само як сайт малює мапу зі схематика.
 * Зріз береться для кожного стовпчика окремо: з області на сайті, де він лежить, або основний зріз шару.
 * Як і на сайті,
 * у кожному стовпчику йдемо вниз до першого непрозорого блока, а прозорі й неповні блоки над ним
 * (скло, вода, смолоскипи, рейки) кладемо поверх. Глибше — темніше, вищі сусіди відкидають тінь.
 * Результат: 256×256 пікселів ARGB, 16 пікселів на блок.
 */
final class ChunkRenderer {
    static final int SIZE = 256;
    private static final int NONE = Integer.MIN_VALUE;
    private static final int MAX_OVER = 6;
    // Тінь від вищого сусіда: від краю клітинки до ~0.45 її ширини (як shadowTiles на сайті).
    private static final float[] RAMP = new float[16];

    static {
        for (int i = 0; i < 16; i++) RAMP[i] = BlockTops.clamp01(1f - (i + 0.5f) / 7.2f);
    }

    private record Plate(BlockTops.Top top, int[] colors) {}

    private final BlockTops tops;
    private final BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();

    ChunkRenderer(BlockTops tops) {
        this.tops = tops;
    }

    /** Увесь чанк з одним зрізом (для перевірок). */
    int[] render(ClientLevel level, int cx, int cz, int sliceTop, int sliceBottom) {
        return render(level, cx, cz, new SiteApi.Layer("", "", "", sliceTop, sliceBottom, 0, 0, 0, -1, -1, List.of(), null));
    }

    /** null, якщо чанк ще не прогружений. */
    int[] render(ClientLevel level, int cx, int cz, SiteApi.Layer layer) {
        LevelChunk[] near = new LevelChunk[9];
        for (int dz = -1; dz <= 1; dz++) {
            for (int dx = -1; dx <= 1; dx++) {
                near[(dz + 1) * 3 + dx + 1] = level.getChunkSource().getChunk(cx + dx, cz + dz, ChunkStatus.FULL, false);
            }
        }
        if (near[4] == null) return null;
        int minY = level.getMinY(), maxY = level.getMaxY();
        int[] out = new int[SIZE * SIZE];

        // Висоти основи для чанка і рамки в один блок навколо (для рельєфу й тіней на краях).
        int[] heights = new int[18 * 18];
        int[] tops = new int[18 * 18], bottoms = new int[18 * 18];
        Arrays.fill(heights, NONE);
        @SuppressWarnings("unchecked")
        List<Plate>[] stacks = new List[256];
        int x0 = cx << 4, z0 = cz << 4;
        for (int lz = -1; lz <= 16; lz++) {
            for (int lx = -1; lx <= 16; lx++) {
                int i = (lz + 1) * 18 + lx + 1;
                SiteApi.Area area = layer.areaAt(x0 + lx, z0 + lz);
                int top = Math.min(area != null ? area.top() : layer.top(), maxY);
                int bottom = Math.max(area != null ? area.bottom() : layer.bottom(), minY);
                tops[i] = top;
                bottoms[i] = bottom;
                LevelChunk ch = near[((lz >> 4) + 1) * 3 + (lx >> 4) + 1];
                if (ch == null || top < bottom) continue;
                boolean inner = lx >= 0 && lx < 16 && lz >= 0 && lz < 16;
                List<Plate> stack = inner ? new ArrayList<>(2) : null;
                heights[i] = column(level, ch, x0 + lx, z0 + lz, top, bottom, stack);
                if (inner) stacks[lz * 16 + lx] = stack;
            }
        }

        for (int lz = 0; lz < 16; lz++) {
            for (int lx = 0; lx < 16; lx++) {
                List<Plate> stack = stacks[lz * 16 + lx];
                if (stack == null || stack.isEmpty()) continue;
                int ci = (lz + 1) * 18 + lx + 1;
                int h = heights[ci];
                int ox = lx * 16, oz = lz * 16;
                int over = stack.size();
                if (h != NONE) {
                    Plate base = stack.get(--over);
                    // Глибше — темніше; як на мапах у грі, вище за північного сусіда — світліше.
                    float range = Math.max(1, tops[ci] - bottoms[ci]);
                    double shade = 0.76 + 0.24 * ((h - bottoms[ci]) / range);
                    int north = heights[lz * 18 + lx + 1];
                    if (north != NONE) shade *= h > north ? 1 : h == north ? 0.95 : 0.84;
                    int a = (int) Math.round((1 - Math.min(1, shade)) * 64);
                    paint(out, base, ox, oz, 1f - a / 64f);
                    // Тінь від вищих сусідів: стіни «стоять», а не намальовані.
                    shadow(out, ox, oz, h, heights[lz * 18 + lx + 1], 0);
                    shadow(out, ox, oz, h, heights[(lz + 2) * 18 + lx + 1], 1);
                    shadow(out, ox, oz, h, heights[(lz + 1) * 18 + lx], 2);
                    shadow(out, ox, oz, h, heights[(lz + 1) * 18 + lx + 2], 3);
                }
                // Неповні блоки: знизу вгору, щоб верхні лягали поверх нижніх.
                for (int i = over - 1; i >= 0; i--) blend(out, stack.get(i), ox, oz);
            }
        }
        return out;
    }

    /** Висота першого непрозорого блока зверху (або NONE). У stack — плитки зверху вниз, основа остання. */
    private int column(ClientLevel level, LevelChunk ch, int wx, int wz, int top, int bottom, List<Plate> stack) {
        int n = 0;
        for (int y = top; y >= bottom; y--) {
            BlockState st = ch.getBlockState(pos.set(wx, y, wz));
            if (st.isAir()) continue;
            FluidState fs = st.getFluidState();
            if (!fs.isEmpty() && !(st.getBlock() instanceof LiquidBlock)) {
                // Блок у воді (плита, сходи, водорості): вода лежить поверх нього.
                BlockTops.Top w = tops.fluidTop(fs);
                if (!w.empty && n < MAX_OVER) {
                    if (stack != null) stack.add(layer(level, w, wx, y, wz));
                    n++;
                }
            }
            BlockTops.Top t = tops.top(st, pos);
            if (t.empty) continue;
            if (t.opaque) {
                if (stack != null) stack.add(layer(level, t, wx, y, wz));
                return y;
            }
            if (n < MAX_OVER) {
                if (stack != null) stack.add(layer(level, t, wx, y, wz));
                n++;
            }
        }
        return NONE;
    }

    private final BlockPos.MutableBlockPos tintPos = new BlockPos.MutableBlockPos();

    private Plate layer(ClientLevel level, BlockTops.Top t, int x, int y, int z) {
        int[] colors = null;
        if (t.tints.length > 0) {
            colors = new int[t.tints.length];
            tintPos.set(x, y, z);
            for (int i = 0; i < colors.length; i++) {
                BlockTintSource src = t.tints[i];
                int c = 0xFFFFFF;
                if (src != null) {
                    try {
                        c = src.colorInWorld(t.tintState, level, tintPos) & 0xFFFFFF;
                    } catch (RuntimeException ignored) {
                        // без відтінку
                    }
                }
                colors[i] = c;
            }
        }
        return new Plate(t, colors);
    }

    private static int tinted(int c, byte ti, int[] colors) {
        if (ti < 0 || colors == null || ti >= colors.length) return c;
        int tc = colors[ti];
        int r = ((c >> 16) & 255) * ((tc >> 16) & 255) / 255;
        int g = ((c >> 8) & 255) * ((tc >> 8) & 255) / 255;
        int b = (c & 255) * (tc & 255) / 255;
        return (c & 0xFF000000) | (r << 16) | (g << 8) | b;
    }

    private static void paint(int[] out, Plate l, int ox, int oz, float k) {
        BlockTops.Top t = l.top;
        for (int py = 0; py < 16; py++) {
            for (int px = 0; px < 16; px++) {
                int i = py * 16 + px;
                int c = tinted(t.argb[i], t.tint[i], l.colors);
                int r = Math.round(((c >> 16) & 255) * k), g = Math.round(((c >> 8) & 255) * k), b = Math.round((c & 255) * k);
                out[(oz + py) * SIZE + ox + px] = 0xFF000000 | (r << 16) | (g << 8) | b;
            }
        }
    }

    /** side: 0 північ, 1 південь, 2 захід, 3 схід. */
    private static void shadow(int[] out, int ox, int oz, int h, int nh, int side) {
        if (nh == NONE || nh <= h) return;
        float alpha = Math.min(1f, (nh - h) / 3f) * 0.5f;
        for (int py = 0; py < 16; py++) {
            for (int px = 0; px < 16; px++) {
                float ramp = switch (side) {
                    case 0 -> RAMP[py];
                    case 1 -> RAMP[15 - py];
                    case 2 -> RAMP[px];
                    default -> RAMP[15 - px];
                };
                if (ramp <= 0) continue;
                float f = 1f - alpha * ramp;
                int at = (oz + py) * SIZE + ox + px;
                int c = out[at];
                int r = Math.round(((c >> 16) & 255) * f), g = Math.round(((c >> 8) & 255) * f), b = Math.round((c & 255) * f);
                out[at] = (c & 0xFF000000) | (r << 16) | (g << 8) | b;
            }
        }
    }

    private static void blend(int[] out, Plate l, int ox, int oz) {
        BlockTops.Top t = l.top;
        for (int py = 0; py < 16; py++) {
            for (int px = 0; px < 16; px++) {
                int i = py * 16 + px;
                int s = t.argb[i];
                int sa = s >>> 24;
                if (sa == 0) continue;
                s = tinted(s, t.tint[i], l.colors);
                int at = (oz + py) * SIZE + ox + px;
                if (sa == 255) {
                    out[at] = s;
                    continue;
                }
                int d = out[at];
                int da = d >>> 24;
                float a = sa / 255f, dw = da / 255f * (1f - a), oa = a + dw;
                int r = Math.round((((s >> 16) & 255) * a + ((d >> 16) & 255) * dw) / oa);
                int g = Math.round((((s >> 8) & 255) * a + ((d >> 8) & 255) * dw) / oa);
                int b = Math.round(((s & 255) * a + (d & 255) * dw) / oa);
                out[at] = (Math.round(oa * 255f) << 24) | (r << 16) | (g << 8) | b;
            }
        }
    }

    /** Мініатюра 16×16 RGBA (піксель на блок) для огляду мапи здалеку. */
    static byte[] mini(int[] img) {
        byte[] out = new byte[16 * 16 * 4];
        for (int bz = 0; bz < 16; bz++) {
            for (int bx = 0; bx < 16; bx++) {
                long r = 0, g = 0, b = 0, as = 0;
                for (int py = 0; py < 16; py++) {
                    for (int px = 0; px < 16; px++) {
                        int c = img[(bz * 16 + py) * SIZE + bx * 16 + px];
                        int a = c >>> 24;
                        r += (long) ((c >> 16) & 255) * a;
                        g += (long) ((c >> 8) & 255) * a;
                        b += (long) (c & 255) * a;
                        as += a;
                    }
                }
                int o = (bz * 16 + bx) * 4;
                if (as > 0) {
                    out[o] = (byte) (r / as);
                    out[o + 1] = (byte) (g / as);
                    out[o + 2] = (byte) (b / as);
                    out[o + 3] = (byte) (as / 256);
                }
            }
        }
        return out;
    }
}
