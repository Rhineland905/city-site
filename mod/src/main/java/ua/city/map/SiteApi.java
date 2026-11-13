package ua.city.map;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Запити до сайту. Викликаються лише з фонового потоку мода. */
final class SiteApi {
    private SiteApi() {}

    static final String USER_AGENT = "CityMap/1.1.2 (Minecraft mod)";

    /** Область, яку редактор додав на сайті: межі в блоках (рівно по чанках, включно) і свій зріз. */
    record Area(int minX, int minZ, int maxX, int maxZ, int top, int bottom) {
        boolean contains(int x, int z) {
            return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
        }

        boolean touches(int cx, int cz) {
            int x0 = cx << 4, z0 = cz << 4;
            return x0 + 15 >= minX && x0 <= maxX && z0 + 15 >= minZ && z0 <= maxZ;
        }

        long size() {
            return (long) (maxX - minX + 1) * (maxZ - minZ + 1);
        }
    }

    /** Коробка 3D-моделі шару у світі (включно). У її межах сайт чекає ще й самі блоки. v — версія моделі. */
    record Model(int minX, int minZ, int maxX, int maxZ, int minY, int maxY, long v) {
        boolean touches(int cx, int cz) {
            int x0 = cx << 4, z0 = cz << 4;
            return x0 + 15 >= minX && x0 <= maxX && z0 + 15 >= minZ && z0 <= maxZ;
        }
    }

    /** Шар мапи, для якого на сайті ввімкнена жива мапа. Межі в блоках, включно, плюс області. model — null, якщо 3D немає. */
    record Layer(String id, String name, String dimension, int top, int bottom, long epoch,
                 int minX, int minZ, int maxX, int maxZ, List<Area> areas, Model model) {
        boolean touches(int cx, int cz) {
            int x0 = cx << 4, z0 = cz << 4;
            if (x0 + 15 >= minX && x0 <= maxX && z0 + 15 >= minZ && z0 <= maxZ) return true;
            for (Area a : areas) if (a.touches(cx, cz)) return true;
            return false;
        }

        /** Область, що діє в цьому стовпчику: найменша з тих, що його містять. null — основний зріз шару. */
        Area areaAt(int x, int z) {
            Area best = null;
            for (Area a : areas) {
                if (a.contains(x, z) && (best == null || a.size() <= best.size())) best = a;
            }
            return best;
        }
    }

    record Tile(int cx, int cz, String hash, long at) {}

    record Index(boolean live, long epoch, List<Tile> tiles, List<Tile> blocks) {}

    /** Помилка з відповіддю сайту: код і текст, який сайт показав би людині. */
    static final class HttpError extends IOException {
        final int status;

        HttpError(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    static List<Layer> layers(String site) throws IOException {
        JsonObject o = json(request("GET", site + "/api/live", Map.of(), null));
        List<Layer> out = new ArrayList<>();
        for (JsonElement e : o.getAsJsonArray("layers")) {
            JsonObject l = e.getAsJsonObject();
            List<Area> areas = new ArrayList<>();
            if (l.has("areas") && l.get("areas").isJsonArray()) {
                for (JsonElement ae : l.getAsJsonArray("areas")) {
                    JsonObject a = ae.getAsJsonObject();
                    areas.add(new Area(a.get("minX").getAsInt(), a.get("minZ").getAsInt(), a.get("maxX").getAsInt(),
                        a.get("maxZ").getAsInt(), a.get("top").getAsInt(), a.get("bottom").getAsInt()));
                }
            }
            Model model = null;
            if (l.has("model") && l.get("model").isJsonObject()) {
                JsonObject m = l.getAsJsonObject("model");
                model = new Model(m.get("minX").getAsInt(), m.get("minZ").getAsInt(), m.get("maxX").getAsInt(), m.get("maxZ").getAsInt(),
                    m.get("minY").getAsInt(), m.get("maxY").getAsInt(), m.has("v") ? m.get("v").getAsLong() : 0);
            }
            out.add(new Layer(l.get("id").getAsString(), l.get("name").getAsString(), l.get("dimension").getAsString(),
                l.get("top").getAsInt(), l.get("bottom").getAsInt(), l.has("epoch") ? l.get("epoch").getAsLong() : 0,
                l.get("minX").getAsInt(), l.get("minZ").getAsInt(), l.get("maxX").getAsInt(), l.get("maxZ").getAsInt(),
                List.copyOf(areas), model));
        }
        return out;
    }

    static Index index(String site, String layer, long since) throws IOException {
        JsonObject o = json(request("GET", site + "/api/live/" + enc(layer) + "?since=" + since, Map.of(), null));
        JsonElement live = o.get("live");
        boolean on = live != null && live.isJsonObject();
        long epoch = on && live.getAsJsonObject().has("epoch") ? live.getAsJsonObject().get("epoch").getAsLong() : 0;
        List<Tile> tiles = new ArrayList<>();
        JsonArray arr = o.getAsJsonArray("tiles");
        if (arr != null) {
            for (JsonElement e : arr) {
                JsonArray t = e.getAsJsonArray();
                tiles.add(new Tile(t.get(0).getAsInt(), t.get(1).getAsInt(), t.get(2).getAsString(), t.get(3).getAsLong()));
            }
        }
        List<Tile> blocks = new ArrayList<>();
        if (o.has("blocks") && o.get("blocks").isJsonArray()) {
            for (JsonElement e : o.getAsJsonArray("blocks")) {
                JsonArray t = e.getAsJsonArray();
                blocks.add(new Tile(t.get(0).getAsInt(), t.get(1).getAsInt(), t.get(2).getAsString(), t.get(3).getAsLong()));
            }
        }
        return new Index(on, epoch, tiles, blocks);
    }

    /** Надсилає пакет чанків. Відповідь сайту: {saved, unchanged, outside}. */
    static JsonObject upload(String site, String layer, String key, String player, byte[] body) throws IOException {
        return json(request("POST", site + "/api/live/" + enc(layer), Map.of(
            "x-live-key", key,
            "x-player", player,
            "content-type", "application/octet-stream"), body));
    }

    /** Надсилає блоки чанків для 3D. Відповідь сайту: {saved, unchanged, outside}. */
    static JsonObject uploadBlocks(String site, String layer, String key, byte[] body) throws IOException {
        return json(request("POST", site + "/api/live/" + enc(layer) + "/blocks", Map.of(
            "x-live-key", key,
            "content-type", "application/octet-stream"), body));
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static JsonObject json(byte[] body) throws IOException {
        try {
            return JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (RuntimeException e) {
            throw new IOException("Сайт відповів не JSON", e);
        }
    }

    // Скільки разів повторити запит, якщо зв'язок обірвався або Cloudflare на мить не відповів, і пауза перед кожним.
    private static final long[] RETRY_MS = {1_500, 5_000};

    /**
     * Запит із повтором. Інтернет гравця і Cloudflare час від часу губляться на кілька секунд
     * (обірване з'єднання, тайм-аут, 502/503/429, «база зайнята»), тож одну таку помилку
     * не рахуємо: пробуємо ще раз. Надсилання повторювати безпечно: сайт порівнює хеші.
     */
    private static byte[] request(String method, String url, Map<String, String> headers, byte[] body) throws IOException {
        for (int attempt = 0; ; attempt++) {
            try {
                return requestOnce(method, url, headers, body);
            } catch (IOException e) {
                if (attempt >= RETRY_MS.length || !transient_(e)) throw e;
                try {
                    Thread.sleep(RETRY_MS[attempt]);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw e;
                }
            }
        }
    }

    /** Чи варто повторити: збій зв'язку або тимчасова відповідь сервера, а не «ключ не той» чи «шар вимкнено». */
    private static boolean transient_(IOException e) {
        if (e instanceof HttpError h) return h.status == 429 || h.status == 500 || h.status >= 502;
        String m = e.getMessage();
        return m == null || !m.startsWith("Неправильна адреса сайту");
    }

    private static byte[] requestOnce(String method, String url, Map<String, String> headers, byte[] body) throws IOException {
        HttpURLConnection c;
        try {
            c = (HttpURLConnection) URI.create(url).toURL().openConnection();
        } catch (IllegalArgumentException e) {
            throw new IOException("Неправильна адреса сайту: " + url, e);
        }
        c.setRequestMethod(method);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(60_000);
        c.setUseCaches(false);
        c.setRequestProperty("User-Agent", USER_AGENT);
        c.setRequestProperty("Accept", "application/json");
        headers.forEach(c::setRequestProperty);
        if (body != null) {
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(body);
            }
        }
        int status = c.getResponseCode();
        byte[] data;
        try (InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream()) {
            data = in == null ? new byte[0] : readAll(in);
        } finally {
            c.disconnect();
        }
        if (status >= 400) {
            String msg = "HTTP " + status;
            try {
                JsonObject o = JsonParser.parseString(new String(data, StandardCharsets.UTF_8)).getAsJsonObject();
                if (o.has("error")) msg = o.get("error").getAsString();
            } catch (RuntimeException ignored) {
                // не JSON: лишаємо код
            }
            throw new HttpError(status, msg);
        }
        return data;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > 32 * 1024 * 1024) throw new IOException("Завелика відповідь сайту");
        }
        return out.toByteArray();
    }
}
