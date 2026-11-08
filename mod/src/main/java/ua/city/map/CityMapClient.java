package ua.city.map;

import com.mojang.brigadier.arguments.StringArgumentType;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.ClientCommands;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientChunkEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Мод «Мапа міста»: сам домальовує мапу на сайті з чанків, які гравець прогрузив у грі. */
public final class CityMapClient implements ClientModInitializer {
    public static final Logger LOG = LoggerFactory.getLogger("CityMap");

    @Override
    public void onInitializeClient() {
        LiveMap live = new LiveMap(Config.load());
        ClientPlayConnectionEvents.JOIN.register((handler, sender, mc) -> live.onJoin(mc));
        ClientPlayConnectionEvents.DISCONNECT.register((handler, mc) -> live.onLeave());
        ClientChunkEvents.CHUNK_LOAD.register(live::onChunkLoad);
        ClientTickEvents.END_CLIENT_TICK.register(live::tick);
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, ctx) -> dispatcher.register(
            ClientCommands.literal("citymap")
                .executes(c -> { live.status(c.getSource()::sendFeedback); return 1; })
                .then(ClientCommands.literal("key")
                    .then(ClientCommands.argument("key", StringArgumentType.greedyString())
                        .executes(c -> { live.setKey(StringArgumentType.getString(c, "key"), c.getSource()::sendFeedback); return 1; })))
                .then(ClientCommands.literal("on").executes(c -> { live.setEnabled(true, c.getSource()::sendFeedback); return 1; }))
                .then(ClientCommands.literal("off").executes(c -> { live.setEnabled(false, c.getSource()::sendFeedback); return 1; }))
                .then(ClientCommands.literal("server").executes(c -> { live.bindServer(c.getSource()::sendFeedback); return 1; }))
                .then(ClientCommands.literal("now").executes(c -> { live.now(c.getSource()::sendFeedback); return 1; }))
                .then(ClientCommands.literal("site")
                    .then(ClientCommands.argument("url", StringArgumentType.greedyString())
                        .executes(c -> { live.setSite(StringArgumentType.getString(c, "url"), c.getSource()::sendFeedback); return 1; })))));
        LOG.info("Мапа міста: мод завантажено");
    }
}
