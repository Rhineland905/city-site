package ua.city.map;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

/** Мінімальний кодувальник PNG: RGB, якщо всі пікселі непрозорі, інакше RGBA. Фільтр рядка вибирається як у libpng. */
final class PngWriter {
    private PngWriter() {}

    static byte[] encode(int[] argb, int w, int h) {
        boolean alpha = false;
        for (int c : argb) {
            if ((c >>> 24) != 255) { alpha = true; break; }
        }
        int bpp = alpha ? 4 : 3;
        int stride = w * bpp;
        byte[] raw = new byte[(stride + 1) * h];
        byte[] prev = new byte[stride];
        byte[] cur = new byte[stride];
        byte[][] cand = new byte[5][stride];
        for (int y = 0; y < h; y++) {
            for (int x = 0, i = 0; x < w; x++) {
                int c = argb[y * w + x];
                int a = c >>> 24;
                if (alpha && a == 0) c = 0; // у прозорих пікселів колір не важливий, нулі краще стискаються
                cur[i++] = (byte) (c >> 16);
                cur[i++] = (byte) (c >> 8);
                cur[i++] = (byte) c;
                if (alpha) cur[i++] = (byte) a;
            }
            int best = 0;
            long bestSum = Long.MAX_VALUE;
            for (int f = 0; f < 5; f++) {
                byte[] out = cand[f];
                long sum = 0;
                for (int i = 0; i < stride; i++) {
                    int left = i >= bpp ? cur[i - bpp] & 255 : 0;
                    int up = prev[i] & 255;
                    int upLeft = i >= bpp ? prev[i - bpp] & 255 : 0;
                    int pred = switch (f) {
                        case 0 -> 0;
                        case 1 -> left;
                        case 2 -> up;
                        case 3 -> (left + up) >>> 1;
                        default -> paeth(left, up, upLeft);
                    };
                    byte v = (byte) ((cur[i] & 255) - pred);
                    out[i] = v;
                    sum += Math.abs(v);
                }
                if (sum < bestSum) { bestSum = sum; best = f; }
            }
            int at = y * (stride + 1);
            raw[at] = (byte) best;
            System.arraycopy(cand[best], 0, raw, at + 1, stride);
            byte[] t = prev; prev = cur; cur = t;
        }

        Deflater d = new Deflater(9);
        d.setInput(raw);
        d.finish();
        ByteArrayOutputStream z = new ByteArrayOutputStream(raw.length / 3);
        byte[] buf = new byte[32768];
        while (!d.finished()) {
            int n = d.deflate(buf);
            z.write(buf, 0, n);
        }
        d.end();

        ByteArrayOutputStream png = new ByteArrayOutputStream(z.size() + 64);
        png.writeBytes(new byte[] {(byte) 137, 80, 78, 71, 13, 10, 26, 10});
        byte[] ihdr = new byte[13];
        putInt(ihdr, 0, w);
        putInt(ihdr, 4, h);
        ihdr[8] = 8;
        ihdr[9] = (byte) (alpha ? 6 : 2);
        chunk(png, "IHDR", ihdr);
        chunk(png, "IDAT", z.toByteArray());
        chunk(png, "IEND", new byte[0]);
        return png.toByteArray();
    }

    private static int paeth(int a, int b, int c) {
        int p = a + b - c;
        int pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        if (pa <= pb && pa <= pc) return a;
        return pb <= pc ? b : c;
    }

    private static void chunk(ByteArrayOutputStream out, String type, byte[] data) {
        byte[] len = new byte[4];
        putInt(len, 0, data.length);
        out.writeBytes(len);
        byte[] t = type.getBytes(StandardCharsets.US_ASCII);
        out.writeBytes(t);
        out.writeBytes(data);
        CRC32 crc = new CRC32();
        crc.update(t);
        crc.update(data);
        byte[] c = new byte[4];
        putInt(c, 0, (int) crc.getValue());
        out.writeBytes(c);
    }

    static void putInt(byte[] b, int at, int v) {
        b[at] = (byte) (v >>> 24);
        b[at + 1] = (byte) (v >>> 16);
        b[at + 2] = (byte) (v >>> 8);
        b[at + 3] = (byte) v;
    }
}
