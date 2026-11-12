package ua.city.map;

import com.google.gson.JsonObject;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.status.ChunkStatus;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Жива мапа: стежить за прогруженими чанками, малює ті, що лежать у межах шарів сайту,
 * і надсилає змінені на сайт. Малювання — в потоці гри (там доступні блоки й моделі),
 * стиснення в PNG і мережа — в окремому потоці, щоб гра не підвисала.
 */
final class LiveMap {
    private static final long TICK_BUDGET_NS = 2_000_000L; // не більше ~2 мс на такт гри (такт триває 50 мс)
    private static final long NEIGHBOUR_WAIT_MS = 10_000;  // чекаємо сусідів, щоб краї чанка вийшли правильними
    private static final long NEAR_SCAN_MS = 20_000;       // поруч із гравцем перемальовуємо часто: там будують
    private static final long FULL_SCAN_MS = 180_000;
    private static final long REFRESH_MS = 60_000;          // шари, області й що вже лежить на сайті
    private static final int BATCH = 24;                   // стільки чанків приймає сайт за раз
    private static final int BATCH_BYTES = 5 * 1024 * 1024;
    private static final int MAX_PENDING = 400;
    private static final byte[] EMPTY_BODY = {'C', 'M', 'T', '1', 0, 0};

    private final Config cfg;
    private final BlockTops tops = new BlockTops();
    private final ChunkRenderer renderer = new ChunkRenderer(tops);
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "CityMap");
        t.setDaemon(true);
        t.setPriority(Thread.MIN_PRIORITY + 1);
        return t;
    });

    // ---- стан у потоці гри ----
    private volatile List<SiteApi.Layer> layers = List.of();
    private final LinkedHashMap<Long, Long> queue = new LinkedHashMap<>(); // чанк → коли поставили в чергу
    private boolean joined;
    private String serverId = "";
    private String player = "";
    private long nextNear, nextFull, nextRefresh, nextFlush;
    private int session; // номер сесії: відповіді зі старої сесії ігноруються
    private boolean renderErrorLogged;
    private static boolean keyHintShown;

    // ---- стан фонового потоку ----
    private final Map<String, Map<Long, String>> known = new HashMap<>();     // що лежить на сайті
    private final Map<String, Map<Long, String>> confirmed = new HashMap<>(); // що ми самі надіслали або бачили на сайті
    private final Map<String, Long> epochs = new HashMap<>();
    private final Map<String, Long> since = new HashMap<>();
    private final Map<String, LinkedHashMap<Long, Pending>> pending = new HashMap<>();
    // Блоки для 3D: що лежить на сайті (хеші), що чекає відправки, версія моделі шару.
    private final Map<String, Map<Long, String>> blocksKnown = new HashMap<>();
    private final Map<String, LinkedHashMap<Long, BlockSync.Encoded>> blocksPending = new HashMap<>();
    private final Map<String, Long> blocksSince = new HashMap<>();
    private final Map<String, Long> modelVersions = new HashMap<>();
    private long nextTry;
    private long nextBlocks;
    private int failures;
    private boolean authFailed;
    private boolean firstUploadShown;
    private boolean offlineShown;

    // ---- лічильники для /citymap ----
    private final AtomicInteger sent = new AtomicInteger();
    private final AtomicInteger sentBlocks = new AtomicInteger();
    private final AtomicInteger unchanged = new AtomicInteger();
    private final AtomicInteger waiting = new AtomicInteger();
    private final AtomicBoolean flushQueued = new AtomicBoolean();
    private volatile String lastError = "";

    private record Pending(int cx, int cz, byte[] hash, String hex, byte[] mini, byte[] png, long at) {}

    LiveMap(Config cfg) {
        this.cfg = cfg;
    }

    // ================= події гри =================

    void onJoin(Minecraft mc) {
        joined = true;
        session++;
        serverId = serverId(mc);
        player = mc.getUser().getName();
        start(false);
        if (cfg.enabled && cfg.key.isEmpty() && !keyHintShown) {
            keyHintShown = true;
            say(Component.literal("Мод стоїть, але ключа ще немає. Попроси його в редактора сайту й введи ")
                .append(cmd("/citymap key <ключ>")).append("."));
        }
    }

    void onLeave() {
        joined = false;
        session++;
        layers = List.of();
        queue.clear();
        int s = session;
        worker.execute(() -> flushAll(true, s)); // що встигли намалювати, відправляємо
    }

    void onChunkLoad(ClientLevel level, LevelChunk chunk) {
        if (!active()) return;
        int cx = chunk.getPos().x(), cz = chunk.getPos().z();
        long now = System.currentTimeMillis();
        String dim = dimension(level);
        for (int dz = -1; dz <= 1; dz++) {
            for (int dx = -1; dx <= 1; dx++) {
                // Сусіди теж: їхні краї (рельєф і тіні) залежать від цього чанка.
                if ((dx != 0 || dz != 0) && !level.hasChunk(cx + dx, cz + dz)) continue;
                if (touches(dim, cx + dx, cz + dz)) queue.putIfAbsent(key(cx + dx, cz + dz), now);
            }
        }
    }

    void tick(Minecraft mc) {
        if (!active() || mc.level == null) return;
        try {
            tickInner(mc);
        } catch (RuntimeException e) {
            if (!renderErrorLogged) {
                renderErrorLogged = true;
                CityMapClient.LOG.error("Жива мапа: помилка", e);
            }
        }
    }

    private void tickInner(Minecraft mc) {
        long now = System.currentTimeMillis();
        ClientLevel level = mc.level;
        if (now >= nextRefresh) {
            nextRefresh = now + REFRESH_MS;
            refresh(false);
        }
        if (layers.isEmpty()) return;
        if (now >= nextNear && mc.player != null) {
            nextNear = now + NEAR_SCAN_MS;
            int pcx = mc.player.getBlockX() >> 4, pcz = mc.player.getBlockZ() >> 4;
            queueArea(level, pcx - 3, pcz - 3, pcx + 3, pcz + 3);
        }
        if (now >= nextFull) {
            nextFull = now + FULL_SCAN_MS;
            queueAllLoaded(level);
        }
        if (now >= nextFlush) {
            nextFlush = now + 2_000;
            requestFlush(false);
        }
        if (queue.isEmpty()) return;
        tops.checkReload();
        String dim = dimension(level);
        long t0 = System.nanoTime();
        int done = 0;
        Iterator<Map.Entry<Long, Long>> it = queue.entrySet().iterator();
        while (it.hasNext() && (done == 0 || System.nanoTime() - t0 < TICK_BUDGET_NS)) {
            Map.Entry<Long, Long> e = it.next();
            long k = e.getKey();
            int cx = (int) (k >> 32), cz = (int) k;
            if (!level.hasChunk(cx, cz)) {
                it.remove();
                continue;
            }
            boolean neighbours = level.hasChunk(cx - 1, cz) && level.hasChunk(cx + 1, cz)
                && level.hasChunk(cx, cz - 1) && level.hasChunk(cx, cz + 1);
            if (!neighbours && now - e.getValue() < NEIGHBOUR_WAIT_MS) continue;
            it.remove();
            for (SiteApi.Layer l : layers) {
                if (!l.dimension().equals(dim) || !l.touches(cx, cz)) continue;
                int[] img = renderer.render(level, cx, cz, l);
                if (img != null) submit(l, cx, cz, img);
                // Для 3D на сайті: швидка копія секцій чанка, решта роботи — у фоновому потоці.
                SiteApi.Model m = l.model();
                if (img != null && m != null && m.touches(cx, cz)) {
                    LevelChunk chunk = level.getChunkSource().getChunk(cx, cz, ChunkStatus.FULL, false);
                    BlockSync.Capture cap = chunk == null ? null : BlockSync.capture(chunk, cx, cz, m.minY(), m.maxY());
                    if (cap != null) submitBlocks(l.id(), cap);
                }
            }
            done++;
        }
    }

    // ================= черга =================

    private boolean active() {
        return joined && cfg.enabled && !cfg.key.isEmpty() && !cfg.server.isEmpty() && cfg.server.equals(serverId);
    }

    private boolean touches(String dim, int cx, int cz) {
        for (SiteApi.Layer l : layers) if (l.dimension().equals(dim) && l.touches(cx, cz)) return true;
        return false;
    }

    private void queueArea(ClientLevel level, int cx0, int cz0, int cx1, int cz1) {
        String dim = dimension(level);
        long now = System.currentTimeMillis();
        for (int cz = cz0; cz <= cz1; cz++) {
            for (int cx = cx0; cx <= cx1; cx++) {
                if (level.hasChunk(cx, cz) && touches(dim, cx, cz)) queue.putIfAbsent(key(cx, cz), now - NEIGHBOUR_WAIT_MS);
            }
        }
    }

    /** Усі прогружені чанки навколо гравця, що лежать у межах шарів і областей цього виміру. */
    private int queueAllLoaded(ClientLevel level) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return 0;
        int before = queue.size();
        int r = mc.options.getEffectiveRenderDistance() + 2;
        int pcx = mc.player.getBlockX() >> 4, pcz = mc.player.getBlockZ() >> 4;
        queueArea(level, pcx - r, pcz - r, pcx + r, pcz + r);
        return queue.size() - before;
    }

    // ================= фоновий потік: хеш, PNG, відправка =================

    private void submit(SiteApi.Layer l, int cx, int cz, int[] img) {
        int s = session;
        waiting.incrementAndGet();
        worker.execute(() -> {
            try {
                prepare(l, cx, cz, img, s);
            } catch (RuntimeException e) {
                CityMapClient.LOG.warn("Жива мапа: не вдалося підготувати чанк {} {}: {}", cx, cz, e.toString());
            } finally {
                waiting.decrementAndGet();
            }
        });
    }

    private void submitBlocks(String layer, BlockSync.Capture cap) {
        int s = session;
        waiting.incrementAndGet();
        worker.execute(() -> {
            try {
                if (s != session) return;
                BlockSync.Encoded e = BlockSync.encode(cap);
                long k = key(cap.cx(), cap.cz());
                LinkedHashMap<Long, BlockSync.Encoded> list = blocksPending.computeIfAbsent(layer, x -> new LinkedHashMap<>());
                list.remove(k);
                if (hex(e.hash()).equals(blocksKnown.computeIfAbsent(layer, x -> new HashMap<>()).get(k))) return; // на сайті вже це
                list.put(k, e);
                while (list.size() > MAX_PENDING) {
                    Iterator<Long> it = list.keySet().iterator();
                    it.next();
                    it.remove();
                }
            } catch (RuntimeException e) {
                CityMapClient.LOG.warn("Жива мапа: не вдалося підготувати блоки чанка {} {}: {}", cap.cx(), cap.cz(), e.toString());
            } finally {
                waiting.decrementAndGet();
            }
        });
    }

    /** Блоки для 3D ідуть після картинок і без поспіху: пакетами раз на кілька секунд. false — помилка, чекаємо. */
    private boolean flushBlocks(String layer, LinkedHashMap<Long, BlockSync.Encoded> list, boolean force) {
        while (!list.isEmpty()) {
            if (!force && list.size() < BATCH && System.currentTimeMillis() < nextBlocks) return true;
            List<BlockSync.Encoded> batch = new ArrayList<>();
            int bytes = 6;
            for (BlockSync.Encoded e : list.values()) {
                if (batch.size() >= BATCH || (!batch.isEmpty() && bytes + e.gzip().length > BATCH_BYTES)) break;
                batch.add(e);
                bytes += 28 + e.gzip().length;
            }
            ByteBuffer bb = ByteBuffer.allocate(bytes);
            bb.put("CMB1".getBytes(StandardCharsets.US_ASCII)).putShort((short) batch.size());
            for (BlockSync.Encoded e : batch) bb.putInt(e.cx()).putInt(e.cz()).put(e.hash()).putInt(e.gzip().length).put(e.gzip());
            try {
                JsonObject r = SiteApi.uploadBlocks(cfg.site, layer, cfg.key, bb.array());
                Map<Long, String> k = blocksKnown.computeIfAbsent(layer, x -> new HashMap<>());
                for (BlockSync.Encoded e : batch) {
                    k.put(key(e.cx(), e.cz()), hex(e.hash()));
                    list.remove(key(e.cx(), e.cz()), e);
                }
                sentBlocks.addAndGet(r.has("saved") ? r.get("saved").getAsInt() : batch.size());
                nextBlocks = System.currentTimeMillis() + 5_000;
                failures = 0;
            } catch (SiteApi.HttpError e) {
                if (e.status == 401 || e.status == 404 || e.status == 409 || e.status == 400 || e.status == 413) {
                    // Ключ, шар чи пакет не підходять: про ключ скаже відправка картинок, а блоки просто не шлемо.
                    CityMapClient.LOG.warn("Жива мапа: сайт не взяв блоки для 3D: {}", e.getMessage());
                    list.clear();
                    return true;
                }
                lastError = e.getMessage();
                backoff();
                return false;
            } catch (Exception e) {
                lastError = e.getMessage() == null ? e.toString() : e.getMessage();
                backoff();
                return false;
            }
        }
        return true;
    }

    private void prepare(SiteApi.Layer l, int cx, int cz, int[] img, int s) {
        if (s != session) return;
        byte[] hash = hash16(img);
        String hex = hex(hash);
        long k = key(cx, cz);
        String onSite = known.computeIfAbsent(l.id(), x -> new HashMap<>()).get(k);
        String mine = confirmed.computeIfAbsent(l.id(), x -> new HashMap<>()).get(k);
        LinkedHashMap<Long, Pending> queueForLayer = pending.computeIfAbsent(l.id(), x -> new LinkedHashMap<>());
        if (hex.equals(onSite) || (onSite != null && hex.equals(mine)) || (onSite == null && blank(img))) {
            // На сайті вже це (або там версія з іншим ресурспаком, а в нас нічого не змінилося).
            // Порожній чанк (у зрізі нічого немає) надсилаємо, лише щоб замінити старий.
            queueForLayer.remove(k);
            confirmed.get(l.id()).put(k, hex);
            unchanged.incrementAndGet();
            return;
        }
        Pending old = queueForLayer.remove(k);
        queueForLayer.put(k, new Pending(cx, cz, hash, hex, ChunkRenderer.mini(img), PngWriter.encode(img, 256, 256),
            old != null ? old.at : System.currentTimeMillis()));
        while (queueForLayer.size() > MAX_PENDING) {
            Iterator<Long> it = queueForLayer.keySet().iterator();
            it.next();
            it.remove();
        }
        flushAll(false, s);
    }

    private void requestFlush(boolean force) {
        if (!flushQueued.compareAndSet(false, true)) return;
        int s = session;
        worker.execute(() -> {
            flushQueued.set(false);
            flushAll(force, s);
        });
    }

    private void flushAll(boolean force, int s) {
        if (authFailed || System.currentTimeMillis() < nextTry) return;
        for (Map.Entry<String, LinkedHashMap<Long, Pending>> e : new ArrayList<>(pending.entrySet())) {
            if (!flushLayer(e.getKey(), e.getValue(), force)) return;
        }
        for (Map.Entry<String, LinkedHashMap<Long, BlockSync.Encoded>> e : new ArrayList<>(blocksPending.entrySet())) {
            if (!flushBlocks(e.getKey(), e.getValue(), force)) return;
        }
    }

    /** false — далі не надсилаємо (помилка, чекаємо). */
    private boolean flushLayer(String layer, LinkedHashMap<Long, Pending> list, boolean force) {
        while (!list.isEmpty()) {
            Pending first = list.values().iterator().next();
            if (!force && list.size() < BATCH && System.currentTimeMillis() - first.at < 3_000) return true;
            List<Pending> batch = new ArrayList<>();
            int bytes = 0;
            for (Pending p : list.values()) {
                if (batch.size() >= BATCH || (!batch.isEmpty() && bytes + p.png.length > BATCH_BYTES)) break;
                batch.add(p);
                bytes += p.png.length + 1100;
            }
            try {
                JsonObject r = SiteApi.upload(cfg.site, layer, cfg.key, player, body(batch));
                Map<Long, String> k = known.computeIfAbsent(layer, x -> new HashMap<>());
                Map<Long, String> c = confirmed.computeIfAbsent(layer, x -> new HashMap<>());
                for (Pending p : batch) {
                    long key = key(p.cx, p.cz);
                    k.put(key, p.hex);
                    c.put(key, p.hex);
                    list.remove(key);
                }
                int saved = r.has("saved") ? r.get("saved").getAsInt() : batch.size();
                sent.addAndGet(saved);
                unchanged.addAndGet(batch.size() - saved);
                failures = 0;
                lastError = "";
                offlineShown = false;
                if (saved > 0 && !firstUploadShown) {
                    firstUploadShown = true;
                    say(Component.literal("Мапа на сайті оновлюється: надіслано " + chunks(saved) + ". ")
                        .append(cmd("/citymap")).append(" покаже стан."));
                }
            } catch (SiteApi.HttpError e) {
                lastError = e.getMessage();
                if (e.status == 401) {
                    authFailed = true;
                    pending.clear();
                    say(Component.literal("Сайт не прийняв ключ. Попроси новий у редактора сайту й введи ")
                        .append(cmd("/citymap key <ключ>")).append(".").withStyle(ChatFormatting.RED));
                    return false;
                }
                if (e.status == 409 || e.status == 404) { // шар вимкнули або видалили
                    pending.remove(layer);
                    Minecraft.getInstance().execute(() -> nextRefresh = 0);
                    return true;
                }
                if (e.status == 400 || e.status == 413) { // такий пакет сайт не візьме ніколи
                    CityMapClient.LOG.warn("Жива мапа: сайт відхилив пакет: {}", e.getMessage());
                    for (Pending p : batch) list.remove(key(p.cx, p.cz));
                    continue;
                }
                backoff();
                return false;
            } catch (Exception e) {
                lastError = e.getMessage() == null ? e.toString() : e.getMessage();
                backoff();
                return false;
            }
        }
        return true;
    }

    private void backoff() {
        failures++;
        nextTry = System.currentTimeMillis() + Math.min(300_000L, 5_000L << Math.min(6, failures - 1));
        if (failures >= 3 && !offlineShown) {
            offlineShown = true;
            say(Component.literal("Не вдається достукатися до сайту, спробую пізніше.").withStyle(ChatFormatting.GRAY));
        }
    }

    private static byte[] body(List<Pending> batch) {
        int size = 6;
        for (Pending p : batch) size += 8 + 16 + p.mini.length + 4 + p.png.length;
        ByteBuffer bb = ByteBuffer.allocate(size);
        bb.put("CMT1".getBytes(StandardCharsets.US_ASCII));
        bb.putShort((short) batch.size());
        for (Pending p : batch) {
            bb.putInt(p.cx).putInt(p.cz).put(p.hash).put(p.mini).putInt(p.png.length).put(p.png);
        }
        return bb.array();
    }

    /** Шари з сайту і список того, що там уже лежить. first — перевірити ключ і сказати гравцю. */
    private void refresh(boolean verify) {
        if (!active() && !verify) return;
        int s = session;
        String site = cfg.site, key = cfg.key, name = player;
        worker.execute(() -> {
            try {
                List<SiteApi.Layer> ls = SiteApi.layers(site);
                for (SiteApi.Layer l : ls) {
                    Long ep = epochs.get(l.id());
                    if (ep == null || ep != l.epoch()) { // зріз змінили або чанки стерли: усе заново
                        epochs.put(l.id(), l.epoch());
                        known.remove(l.id());
                        confirmed.remove(l.id());
                        since.remove(l.id());
                        pending.remove(l.id());
                    }
                    long mv = l.model() == null ? -1 : l.model().v();
                    Long old = modelVersions.put(l.id(), mv);
                    if (old == null || old != mv) { // на сайт поклали інший схематик: блоки надсилаємо заново
                        blocksKnown.remove(l.id());
                        blocksPending.remove(l.id());
                        blocksSince.remove(l.id());
                    }
                    SiteApi.Index idx = SiteApi.index(site, l.id(), since.getOrDefault(l.id(), 0L));
                    Map<Long, String> k = known.computeIfAbsent(l.id(), x -> new HashMap<>());
                    long max = since.getOrDefault(l.id(), 0L);
                    for (SiteApi.Tile t : idx.tiles()) {
                        k.put(key(t.cx(), t.cz()), t.hash());
                        max = Math.max(max, t.at());
                    }
                    since.put(l.id(), max);
                    Map<Long, String> bk = blocksKnown.computeIfAbsent(l.id(), x -> new HashMap<>());
                    for (SiteApi.Tile t : idx.blocks()) bk.put(key(t.cx(), t.cz()), t.hash());
                }
                if (verify) verifyKey(site, key, name, ls);
                Minecraft.getInstance().execute(() -> {
                    if (s != session) return;
                    boolean changed = !ls.equals(layers);
                    layers = List.copyOf(ls);
                    lastError = "";
                    if (changed && Minecraft.getInstance().level != null) queueAllLoaded(Minecraft.getInstance().level);
                });
            } catch (Exception e) {
                lastError = e.getMessage() == null ? e.toString() : e.getMessage();
                CityMapClient.LOG.warn("Жива мапа: не вдалося отримати шари з сайту: {}", lastError);
                Minecraft.getInstance().execute(() -> nextRefresh = Math.min(nextRefresh, System.currentTimeMillis() + 60_000));
                if (verify) say(Component.literal("Не вдалося з'єднатися з сайтом: " + lastError).withStyle(ChatFormatting.RED));
            }
        });
    }

    private void verifyKey(String site, String key, String name, List<SiteApi.Layer> ls) {
        if (ls.isEmpty()) {
            say(Component.literal("Ключ збережено, але на сайті жива мапа ще ніде не ввімкнена. Попроси редактора ввімкнути її у вікні «Жива мапа»."));
            return;
        }
        try {
            SiteApi.upload(site, ls.get(0).id(), key, name, EMPTY_BODY);
            authFailed = false;
            say(Component.literal("Ключ підходить. Мапа оновлюватиметься сама, поки ти граєш на цьому сервері.")
                .withStyle(ChatFormatting.GREEN));
        } catch (SiteApi.HttpError e) {
            if (e.status == 401) {
                authFailed = true;
                say(Component.literal("Сайт не прийняв ключ. Перевір, що скопіював команду повністю, або попроси новий ключ.")
                    .withStyle(ChatFormatting.RED));
            } else {
                say(Component.literal("Не вдалося перевірити ключ: " + e.getMessage()).withStyle(ChatFormatting.RED));
            }
        } catch (Exception e) {
            say(Component.literal("Не вдалося перевірити ключ: " + e).withStyle(ChatFormatting.RED));
        }
    }

    /** Почати заново: після входу на сервер або зміни налаштувань. */
    private void start(boolean verify) {
        queue.clear();
        layers = List.of();
        nextNear = nextFull = nextFlush = 0;
        nextRefresh = System.currentTimeMillis() + REFRESH_MS;
        worker.execute(() -> {
            authFailed = false;
            failures = 0;
            nextTry = 0;
            firstUploadShown = false;
        });
        if (active()) refresh(verify);
    }

    // ================= команди =================

    void setKey(String raw, Consumer<Component> out) {
        String key = raw.trim();
        if (key.startsWith("/citymap key ")) key = key.substring(13).trim();
        if (!key.matches("[A-Za-z0-9_-]{16,100}")) {
            out.accept(prefix(Component.literal("Це не схоже на ключ. Скопіюй команду з сайту повністю.").withStyle(ChatFormatting.RED)));
            return;
        }
        cfg.key = key;
        cfg.server = serverId;
        cfg.enabled = true;
        cfg.save();
        out.accept(prefix(Component.literal("Ключ збережено. Мапа надсилатиметься лише звідси: " + serverLabel(serverId) + ". Перевіряю ключ…")));
        start(true);
    }

    void setEnabled(boolean on, Consumer<Component> out) {
        cfg.enabled = on;
        cfg.save();
        out.accept(prefix(Component.literal(on ? "Мод увімкнено." : "Мод вимкнено: мапа не надсилається.")));
        start(false);
    }

    void bindServer(Consumer<Component> out) {
        cfg.server = serverId;
        cfg.save();
        out.accept(prefix(Component.literal("Тепер мапа надсилатиметься звідси: " + serverLabel(serverId) + ".")));
        start(!cfg.key.isEmpty());
    }

    void setSite(String url, Consumer<Component> out) {
        String u = url.trim().replaceAll("/+$", "");
        if (!u.matches("https?://[^\\s/]+(/[^\\s]*)?")) {
            out.accept(prefix(Component.literal("Потрібна адреса на кшталт https://city-site-ak6.pages.dev").withStyle(ChatFormatting.RED)));
            return;
        }
        cfg.site = u;
        cfg.save();
        out.accept(prefix(Component.literal("Адреса сайту: " + u)));
        start(!cfg.key.isEmpty());
    }

    void now(Consumer<Component> out) {
        Minecraft mc = Minecraft.getInstance();
        if (!active() || mc.level == null) {
            status(out);
            return;
        }
        // Примусово перемалювати й надіслати всі прогружені чанки в межах мапи.
        int s = session;
        worker.execute(() -> {
            if (s != session) return;
            confirmed.clear();
            authFailed = false;
            nextTry = 0;
        });
        int n = queueAllLoaded(mc.level);
        for (Map.Entry<Long, Long> e : queue.entrySet()) e.setValue(0L);
        requestFlush(true);
        out.accept(prefix(Component.literal("Перемальовую прогружені чанки в межах мапи: " + chunks(Math.max(n, queue.size())) + ".")));
    }

    void status(Consumer<Component> out) {
        out.accept(prefix(Component.literal(cfg.enabled ? "Увімкнено" : "Вимкнено").withStyle(cfg.enabled ? ChatFormatting.GREEN : ChatFormatting.GRAY)
            .append(Component.literal(" · сайт " + cfg.site.replaceFirst("^https?://", "")).withStyle(ChatFormatting.GRAY))));
        if (cfg.key.isEmpty()) {
            out.accept(Component.literal("Ключа немає. Попроси його в редактора сайту й введи ").append(cmd("/citymap key <ключ>")));
            return;
        }
        if (!cfg.server.equals(serverId)) {
            out.accept(Component.literal("Мапа надсилається лише з " + serverLabel(cfg.server) + ", а зараз " + serverLabel(serverId)
                + ". Щоб надсилати звідси: ").append(cmd("/citymap server")));
            return;
        }
        if (!cfg.enabled) {
            out.accept(Component.literal("Увімкнути: ").append(cmd("/citymap on")));
            return;
        }
        List<SiteApi.Layer> ls = layers;
        if (ls.isEmpty()) {
            out.accept(Component.literal(lastError.isEmpty() ? "На сайті жива мапа ще ніде не ввімкнена (або сайт ще відповідає)."
                : "Сайт недоступний: " + lastError).withStyle(ChatFormatting.GRAY));
        } else {
            StringBuilder sb = new StringBuilder("Шари: ");
            for (int i = 0; i < ls.size(); i++) {
                SiteApi.Layer l = ls.get(i);
                if (i > 0) sb.append(", ");
                sb.append(l.name()).append(" (").append(dimLabel(l.dimension())).append(", Y ").append(l.top()).append("…").append(l.bottom());
                if (!l.areas().isEmpty()) sb.append(", областей: ").append(l.areas().size());
                sb.append(")");
            }
            out.accept(Component.literal(sb.toString()));
        }
        int inQueue = queue.size() + waiting.get();
        out.accept(Component.literal("Надіслано за сесію: " + chunks(sent.get()) + ", без змін: " + unchanged.get()
            + (inQueue > 0 ? ", у черзі: " + inQueue : "")));
        if (sentBlocks.get() > 0) out.accept(Component.literal("Для 3D надіслано блоки: " + chunks(sentBlocks.get())).withStyle(ChatFormatting.GRAY));
        if (!lastError.isEmpty()) out.accept(Component.literal("Остання помилка: " + lastError).withStyle(ChatFormatting.RED));
    }

    // ================= дрібниці =================

    static long key(int cx, int cz) {
        return ((long) cx << 32) | (cz & 0xFFFFFFFFL);
    }

    static String dimension(Level level) {
        if (level.dimension() == Level.OVERWORLD) return "overworld";
        if (level.dimension() == Level.NETHER) return "nether";
        if (level.dimension() == Level.END) return "end";
        return level.dimension().identifier().getPath();
    }

    private static String dimLabel(String d) {
        return switch (d) {
            case "overworld" -> "верхній світ";
            case "nether" -> "незер";
            case "end" -> "енд";
            default -> d;
        };
    }

    static String serverId(Minecraft mc) {
        ServerData d = mc.getCurrentServer();
        if (d != null && d.ip != null && !d.ip.isBlank()) {
            String s = d.ip.trim().toLowerCase(Locale.ROOT);
            if (s.endsWith(":25565")) s = s.substring(0, s.length() - 6);
            return s;
        }
        if (mc.hasSingleplayerServer()) return "singleplayer";
        return "";
    }

    private static String serverLabel(String id) {
        if (id == null || id.isEmpty()) return "невідомо";
        return id.equals("singleplayer") ? "одиночна гра" : id;
    }

    static String chunks(int n) {
        int d = n % 10, h = n % 100;
        String w = d == 1 && h != 11 ? "чанк" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "чанки" : "чанків";
        return n + " " + w;
    }

    private static boolean blank(int[] img) {
        for (int c : img) if (c >>> 24 != 0) return false;
        return true;
    }

    private static byte[] hash16(int[] img) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            ByteBuffer bb = ByteBuffer.allocate(img.length * 4);
            bb.asIntBuffer().put(img);
            byte[] full = md.digest(bb.array());
            byte[] out = new byte[16];
            System.arraycopy(full, 0, out, 0, 16);
            return out;
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
        return sb.toString();
    }

    static MutableComponent prefix(Component text) {
        return Component.literal("[Мапа міста] ").withStyle(ChatFormatting.DARK_AQUA).append(text);
    }

    private static MutableComponent cmd(String text) {
        return Component.literal(text).withStyle(ChatFormatting.AQUA);
    }

    /** Повідомлення в чат (з будь-якого потоку). */
    private static void say(Component text) {
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            if (mc.player != null) mc.player.sendSystemMessage(prefix(text));
        });
    }
}
