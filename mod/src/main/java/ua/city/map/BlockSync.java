package ua.city.map;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.PalettedContainer;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.GZIPOutputStream;

/**
 * Блоки чанка для 3D на сайті. Щоб гра не підвисала, у потоці гри робимо лише швидку копію
 * секцій чанка ({@link #capture}); перебір блоків, палітра, хеш і стиснення — у фоновому потоці ({@link #encode}).
 *
 * Формат (big-endian, потім gzip): i16 нижня висота, u16 кількість шарів, u16 розмір палітри,
 * стани блоків (u16 довжина + UTF-8, як у схематику: minecraft:oak_stairs[facing=east,half=bottom]),
 * далі номери в палітрі в порядку x + z*16 + y*256: по байту, якщо станів не більше 256, інакше по два.
 */
final class BlockSync {
    private BlockSync() {}

    /** Копія секцій чанка між двома висотами. sections[i] == null — секція з самого повітря. */
    record Capture(int cx, int cz, int minY, int maxY, int firstSectionY, PalettedContainer<BlockState>[] sections) {}

    record Encoded(int cx, int cz, byte[] hash, byte[] gzip) {}

    /** У потоці гри. null, якщо в цьому світі таких висот немає. */
    static Capture capture(LevelChunk chunk, int cx, int cz, int minY, int maxY) {
        int lo = Math.max(minY, chunk.getMinY()), hi = Math.min(maxY, chunk.getMaxY());
        if (lo > hi) return null;
        LevelChunkSection[] all = chunk.getSections();
        int s0 = chunk.getSectionIndex(lo), s1 = chunk.getSectionIndex(hi);
        @SuppressWarnings("unchecked")
        PalettedContainer<BlockState>[] copy = new PalettedContainer[s1 - s0 + 1];
        for (int s = s0; s <= s1; s++) {
            LevelChunkSection sec = all[s];
            if (sec != null && !sec.hasOnlyAir()) copy[s - s0] = sec.getStates().copy();
        }
        return new Capture(cx, cz, lo, hi, chunk.getSectionYFromSectionIndex(s0), copy);
    }

    // Назви станів рахуємо раз: їх небагато, а блоків у чанку десятки тисяч. Лише фоновий потік.
    private static final Map<BlockState, String> NAMES = new IdentityHashMap<>();

    static String name(BlockState state) {
        String n = NAMES.get(state);
        if (n != null) return n;
        StringBuilder sb = new StringBuilder(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
        TreeMap<String, String> props = new TreeMap<>();
        for (Property<?> p : state.getProperties()) props.put(p.getName(), value(state, p));
        if (!props.isEmpty()) {
            sb.append('[');
            boolean first = true;
            for (Map.Entry<String, String> e : props.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(e.getKey()).append('=').append(e.getValue());
            }
            sb.append(']');
        }
        n = sb.toString();
        NAMES.put(state, n);
        return n;
    }

    private static <T extends Comparable<T>> String value(BlockState state, Property<T> p) {
        return p.getName(state.getValue(p));
    }

    /** У фоновому потоці. */
    static Encoded encode(Capture c) {
        int h = c.maxY - c.minY + 1;
        short[] ids = new short[h * 256];
        Map<BlockState, Integer> index = new IdentityHashMap<>();
        List<String> palette = new ArrayList<>();
        palette.add("minecraft:air"); // 0 — повітря, і для порожніх секцій теж
        int baseY = c.firstSectionY << 4;
        for (int y = c.minY; y <= c.maxY; y++) {
            PalettedContainer<BlockState> sec = c.sections[(y - baseY) >> 4];
            if (sec == null) continue;
            int ly = y & 15, row = (y - c.minY) * 256;
            for (int z = 0; z < 16; z++) {
                for (int x = 0; x < 16; x++) {
                    BlockState st = sec.get(x, ly, z);
                    Integer id = index.get(st);
                    if (id == null) {
                        if (st.isAir()) {
                            id = 0;
                        } else {
                            id = palette.size();
                            palette.add(name(st));
                        }
                        index.put(st, id);
                    }
                    ids[row + z * 16 + x] = (short) (int) id;
                }
            }
        }
        try {
            ByteArrayOutputStream raw = new ByteArrayOutputStream(ids.length + 256);
            DataOutputStream out = new DataOutputStream(raw);
            out.writeShort(c.minY);
            out.writeShort(h);
            out.writeShort(palette.size());
            for (String s : palette) {
                byte[] b = s.getBytes(StandardCharsets.UTF_8);
                out.writeShort(b.length);
                out.write(b);
            }
            boolean wide = palette.size() > 256;
            for (short id : ids) {
                if (wide) out.writeShort(id); else out.writeByte(id);
            }
            out.flush();
            byte[] plain = raw.toByteArray();
            byte[] full = MessageDigest.getInstance("SHA-1").digest(plain);
            byte[] hash = new byte[16];
            System.arraycopy(full, 0, hash, 0, 16);
            ByteArrayOutputStream packed = new ByteArrayOutputStream(4096);
            try (GZIPOutputStream gz = new GZIPOutputStream(packed)) {
                gz.write(plain);
            }
            return new Encoded(c.cx, c.cz, hash, packed.toByteArray());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
