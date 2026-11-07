// Цвета блоков для 3D-превью и карты из схематика.
// Частые блоки заданы вручную, остальные получают спокойный цвет по хэшу имени.

const AIR_RE = /(^|:)(air|cave_air|void_air|structure_void|barrier|light)$/;
export const isAir = (name) => !name || AIR_RE.test(name);
export const isSeeThrough = (name) => isAir(name) || /glass|ice$|leaves|water|bubble_column/.test(name);

// Природные блоки: порода, руды, жидкости, растительность пещер. Их можно скрыть в 3D,
// чтобы подземная постройка не выглядела сплошным куском камня.
const NATURAL_RE = /^minecraft:(stone|deepslate|tuff|granite|diorite|andesite|calcite|dirt|coarse_dirt|rooted_dirt|gravel|sand|red_sand|sandstone|clay|mud|bedrock|netherrack|end_stone|smooth_basalt|basalt|blackstone|dripstone_block|pointed_dripstone|moss_block|moss_carpet|glow_lichen|sculk|sculk_vein|sculk_sensor|sculk_shrieker|sculk_catalyst|infested_\w+|amethyst_block|budding_amethyst|\w+_amethyst_bud|amethyst_cluster|water|lava|grass_block|podzol|mycelium|snow|snow_block|powder_snow|ice|packed_ice|blue_ice|obsidian|magma_block|soul_sand|soul_soil|cave_vines(_plant)?|hanging_roots|spore_blossom|azalea|flowering_azalea|big_dripleaf(_stem)?|small_dripleaf|short_grass|grass|tall_grass|fern|large_fern|seagrass|tall_seagrass|kelp(_plant)?|vine|\w+_ore)$/;
export const isNatural = (name) => !!name && NATURAL_RE.test(name);

const COLORS = [
  [/glass/, 0xbfe3ef], [/water|bubble_column/, 0x3f76e4], [/lava/, 0xe35a10],
  [/sculk_sensor|sculk_shrieker|sculk_catalyst/, 0x1e7d84], [/sculk/, 0x0c2a33],
  [/grass_block|moss/, 0x6a9c3e], [/leaves/, 0x4a7f2c], [/dirt|mud|podzol|rooted/, 0x866043],
  [/sand(?!stone)/, 0xdbcf9c], [/sandstone/, 0xd8cb8f], [/dark_oak/, 0x4a3420], [/oak/, 0xa2824e],
  [/spruce/, 0x6b4f2e], [/birch/, 0xd7c98a], [/jungle/, 0xa07350], [/acacia/, 0xaa5a32],
  [/mangrove/, 0x773631], [/cherry/, 0xe3b4b0], [/bamboo/, 0xc8b65a], [/crimson/, 0x7a3a53],
  [/warped/, 0x2b6963], [/deepslate|tuff/, 0x4d4d52], [/blackstone|basalt/, 0x2e2a2f],
  [/andesite/, 0x8a8a8b], [/diorite|calcite/, 0xc5c5c5], [/granite/, 0x9a6b56], [/cobble/, 0x7a7a7a],
  [/stone/, 0x7f7f7f], [/brick/, 0x96503f], [/quartz/, 0xebe5de], [/terracotta/, 0x9b5f45],
  [/copper/, 0xc0704f], [/iron/, 0xd8d8d8], [/gold/, 0xf5d33c], [/diamond/, 0x5ee0d8],
  [/emerald/, 0x3ad06a], [/obsidian/, 0x1b1426], [/netherrack/, 0x6e3333], [/end_stone/, 0xdbdea0],
  [/purpur/, 0xa77ba7], [/prismarine/, 0x5ea896], [/snow/, 0xf3fafa], [/ice/, 0x9ebdf5],
  [/glowstone|lantern|torch|lamp|shroomlight|froglight|candle/, 0xf3cc6a], [/clay/, 0xa0a6b3],
  [/amethyst/, 0x8d6acc], [/white/, 0xe9ecec], [/orange/, 0xf07613], [/magenta/, 0xbd44b3],
  [/light_blue/, 0x3aafd9], [/yellow/, 0xf8c627], [/lime/, 0x70b919], [/pink/, 0xed8dac],
  [/light_gray/, 0x8e8e86], [/gray/, 0x3e4447], [/cyan/, 0x158991], [/purple/, 0x792aac],
  [/blue/, 0x35399d], [/brown/, 0x724728], [/green/, 0x546d1b], [/red/, 0xa12722], [/black/, 0x141519],
];

const cache = new Map();
export function blockColor(name) {
  let c = cache.get(name);
  if (c !== undefined) return c;
  c = null;
  for (const [re, color] of COLORS) if (re.test(name)) { c = color; break; }
  if (c === null) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    c = hsl((h % 360) / 360, 0.3, 0.5);
  }
  cache.set(name, c);
  return c;
}

function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}
