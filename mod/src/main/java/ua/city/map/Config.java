package ua.city.map;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/** Налаштування мода у файлі config/citymap.json. */
public final class Config {
    public static final String DEFAULT_SITE = "https://city-site-ak6.pages.dev";

    /** Адреса сайту з мапою. */
    public String site = DEFAULT_SITE;
    /** Ключ від редактора сайту: без нього мод нічого не надсилає. */
    public String key = "";
    public boolean enabled = true;
    /** Сервер, на якому ввели ключ. Мапа надсилається лише звідти, щоб чужі світи не потрапили на сайт. */
    public String server = "";

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

    static Path file() {
        return FabricLoader.getInstance().getConfigDir().resolve("citymap.json");
    }

    static Config load() {
        Path f = file();
        if (Files.isRegularFile(f)) {
            try (Reader r = Files.newBufferedReader(f, StandardCharsets.UTF_8)) {
                Config c = GSON.fromJson(r, Config.class);
                if (c != null) {
                    c.normalize();
                    return c;
                }
            } catch (Exception e) {
                CityMapClient.LOG.warn("Не вдалося прочитати {}: {}", f, e.toString());
            }
        }
        Config c = new Config();
        c.save();
        return c;
    }

    void normalize() {
        if (site == null || site.isBlank()) site = DEFAULT_SITE;
        site = site.trim().replaceAll("/+$", "");
        if (key == null) key = "";
        key = key.trim();
        if (server == null) server = "";
    }

    void save() {
        Path f = file();
        try {
            Files.createDirectories(f.getParent());
            Path tmp = f.resolveSibling(f.getFileName() + ".tmp");
            try (Writer w = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
                GSON.toJson(this, w);
            }
            Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception e) {
            CityMapClient.LOG.warn("Не вдалося зберегти {}: {}", f, e.toString());
        }
    }
}
