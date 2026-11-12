package ua.city.map;

import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestServerContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Будує біля центру міста (X 4250, Z 1550) сцену з різних блоків на висоті зрізу −37…−53,
 * малює її чанки так само, як мод (у build/run/clientGameTest/citymap-test/*.png),
 * і чекає, поки мод сам надішле їх на сайт із налаштувань.
 */
public class CityMapGameTest implements FabricClientGameTest {
    private static final List<String> SAMPLES = List.of(
        "grass_block", "oak_planks", "cobblestone", "oak_log", "oak_slab", "oak_stairs[facing=north]", "oak_stairs[facing=east]", "white_carpet",
        "glass", "water", "lava", "torch", "poppy", "oak_leaves[persistent=true]", "chest[facing=south]", "lantern",
        "oak_fence", "cobblestone_wall", "rail", "redstone_wire[power=15]", "iron_bars", "glass_pane", "bookshelf", "crafting_table",
        "furnace[facing=north]", "sculk", "deepslate_bricks", "polished_deepslate", "soul_lantern", "sea_lantern", "ice", "hay_block",
        "tnt", "birch_leaves[persistent=true]", "spruce_leaves[persistent=true]", "short_grass", "fern", "sugar_cane", "wheat[age=7]", "oak_sapling",
        "dandelion", "brown_mushroom", "potted_poppy", "campfire", "lectern", "anvil", "water_cauldron[level=3]", "composter",
        "bell", "iron_chain", "end_rod", "lightning_rod", "oak_trapdoor", "oak_sign", "skeleton_skull", "white_banner",
        "shulker_box", "decorated_pot", "copper_chest", "oak_slab[waterlogged=true]", "stone_brick_stairs[facing=south,waterlogged=true]",
        "white_stained_glass", "moss_carpet", "ender_chest[facing=east]");

    @Override
    public void runTest(ClientGameTestContext ctx) {
        try (TestSingleplayerContext sp = ctx.worldBuilder().create()) {
            TestServerContext srv = sp.getServer();
            srv.runCommand("tp @a 4248 -44 1544");
            ctx.waitFor(mc -> mc.level != null && mc.player != null && Math.abs(mc.player.getX() - 4248) < 2, 400);
            ctx.waitFor(mc -> {
                for (int cz = 95; cz <= 97; cz++) for (int cx = 264; cx <= 266; cx++) if (!mc.level.hasChunk(cx, cz)) return false;
                return true;
            }, 1200);
            srv.runCommand("gamemode spectator @a");
            // Сервер змінює блоки лише в завантажених чанках: тримаємо всю сцену завантаженою.
            srv.runCommand("forceload add 4208 1504 4287 1583");
            ctx.waitTicks(60);
            srv.runCommand("fill 4208 -53 1504 4287 -53 1583 stone");
            srv.runCommand("fill 4208 -52 1504 4287 -38 1583 air");
            // Зразки в чанку 265 96: по одному блоку через клітинку.
            for (int i = 0; i < SAMPLES.size(); i++) {
                int x = 4240 + (i % 8) * 2, z = 1536 + (i / 8) * 2;
                srv.runCommand("setblock " + x + " -52 " + z + " " + SAMPLES.get(i));
            }
            srv.runCommand("setblock 4240 -52 1551 red_bed[facing=east,part=foot]");
            srv.runCommand("setblock 4241 -52 1551 red_bed[facing=east,part=head]");
            // Кімната, басейн, лава, сходи й скляний дах у чанку 266 96.
            srv.runCommand("fill 4257 -52 1537 4263 -50 1543 stone_bricks hollow");
            srv.runCommand("fill 4258 -53 1538 4262 -53 1542 oak_planks");
            srv.runCommand("setblock 4260 -52 1537 air");
            srv.runCommand("setblock 4260 -51 1537 air");
            srv.runCommand("fill 4258 -50 1538 4262 -50 1542 glass");
            srv.runCommand("setblock 4259 -52 1539 chest[facing=south]");
            srv.runCommand("fill 4257 -52 1546 4262 -52 1549 water");
            srv.runCommand("fill 4265 -52 1546 4266 -52 1547 lava");
            srv.runCommand("fill 4268 -52 1538 4268 -50 1538 stone");
            srv.runCommand("setblock 4265 -52 1550 stone_stairs[facing=east]");
            srv.runCommand("setblock 4266 -51 1550 stone_stairs[facing=east]");
            srv.runCommand("setblock 4267 -50 1550 stone_stairs[facing=east]");
            srv.runCommand("fill 4268 -52 1550 4270 -50 1550 stone");
            // Трава й квіти в чанку 264 96, дірка без підлоги в чанку 265 97.
            srv.runCommand("fill 4226 -53 1538 4237 -53 1549 grass_block");
            srv.runCommand("fill 4228 -52 1540 4229 -52 1541 short_grass");
            srv.runCommand("setblock 4232 -52 1542 dandelion");
            srv.runCommand("setblock 4234 -52 1544 oak_leaves[persistent=true]");
            srv.runCommand("fill 4244 -53 1556 4251 -53 1562 air");
            ctx.waitTicks(60);

            Path dir = FabricLoader.getInstance().getGameDir().resolve("citymap-test");
            ctx.runOnClient(mc -> {
                try {
                    renderScene(mc, dir);
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            });
            // Мод сам малює й надсилає чанки; даємо йому час (сусіди + пакет раз на 3 с).
            ctx.waitTicks(400);
            // Область за межами шару (її додає перевірка сайту перед запуском): мод має надіслати і її.
            srv.runCommand("forceload add 4416 1536 4447 1551");
            ctx.waitTicks(40);
            srv.runCommand("fill 4416 -53 1536 4447 -53 1551 deepslate_tiles");
            srv.runCommand("fill 4420 -52 1540 4426 -52 1546 oak_planks");
            srv.runCommand("setblock 4423 -51 1543 lantern");
            srv.runCommand("tp @a 4432 -44 1544");
            ctx.waitTicks(400);
            srv.runCommand("tp @a 4248 -44 1544");
            ctx.waitTicks(100);
            ctx.runOnClient(mc -> mc.player.connection.sendCommand("citymap"));
            ctx.waitTicks(10);
            srv.runCommand("tp @a 4248 -30 1544 0 90");
            ctx.waitTicks(40);
            ctx.takeScreenshot("citymap-scene");
        }
    }

    private static void renderScene(net.minecraft.client.Minecraft mc, Path dir) throws IOException {
        Files.createDirectories(dir);
        BlockTops tops = new BlockTops();
        ChunkRenderer renderer = new ChunkRenderer(tops);
        int[] all = new int[768 * 768];
        for (int cz = 95; cz <= 97; cz++) {
            for (int cx = 264; cx <= 266; cx++) {
                long t0 = System.nanoTime();
                int[] img = renderer.render(mc.level, cx, cz, -37, -53);
                long ms = (System.nanoTime() - t0) / 1_000_000;
                if (img == null) throw new IllegalStateException("chunk not loaded " + cx + " " + cz);
                byte[] png = PngWriter.encode(img, 256, 256);
                Files.write(dir.resolve(cx + "_" + cz + ".png"), png);
                CityMapClient.LOG.info("TEST render {} {}: {} ms, png {} bytes", cx, cz, ms, png.length);
                for (int y = 0; y < 256; y++) {
                    System.arraycopy(img, y * 256, all, ((cz - 95) * 256 + y) * 768 + (cx - 264) * 256, 256);
                }
            }
        }
        Files.write(dir.resolve("all.png"), PngWriter.encode(all, 768, 768));

        // Області: велика з основним зрізом на всі 9 чанків і мала на чанку 266 96 нижче (без даху кімнати).
        SiteApi.Layer layer = new SiteApi.Layer("t", "t", "overworld", -37, -53, 0, 0, 0, -1, -1, List.of(
            new SiteApi.Area(4224, 1520, 4271, 1567, -37, -53),
            new SiteApi.Area(4256, 1536, 4271, 1551, -51, -60)), null);
        for (int cz = 95; cz <= 97; cz++) {
            for (int cx = 264; cx <= 266; cx++) {
                if (!layer.touches(cx, cz)) throw new IllegalStateException("area does not touch " + cx + " " + cz);
                int[] img = renderer.render(mc.level, cx, cz, layer);
                for (int y = 0; y < 256; y++) {
                    System.arraycopy(img, y * 256, all, ((cz - 95) * 256 + y) * 768 + (cx - 264) * 256, 256);
                }
            }
        }
        if (layer.touches(263, 96) || layer.touches(267, 96)) throw new IllegalStateException("area touches too much");
        Files.write(dir.resolve("areas.png"), PngWriter.encode(all, 768, 768));
    }
}
