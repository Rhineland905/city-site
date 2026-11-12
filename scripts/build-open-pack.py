#!/usr/bin/env python3
"""Збирає відкриті текстури блоків в один аркуш для 3D без файлу гри.

Джерела (обидва дозволяють поширення з указанням авторів, CC BY-SA):
  1. Pixel Perfection CE  https://github.com/Athemis/PixelPerfectionCE  (CC BY-SA 4.0), імена як у Minecraft 1.16
  2. VoxeLibre            https://github.com/VoxeLibre/VoxeLibre        (CC BY-SA, на основі Pixel Perfection)
     — для блоків, яких у 1.16 ще не було: глибинний сланець, туф, мідь, скалк, аметист, бруд, мангри, вишня, бамбук.

  python3 scripts/build-open-pack.py <PixelPerfectionCE> <VoxeLibre>

Пише public/pack/blocks.png (квадрати 16×16 рядами), public/pack/blocks.json ({ ім'я: [номер, тонувати] }).
"""
import json, os, sys
from PIL import Image

pp, vl = sys.argv[1], sys.argv[2]
out = os.path.join(os.path.dirname(__file__), '..', 'public', 'pack')
os.makedirs(out, exist_ok=True)
S = 16

# Текстури, які в грі фарбуються кольором біому (сірі в паку).
TINT = {'grass_block_top', 'grass_block_side_overlay', 'oak_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves',
        'mangrove_leaves', 'birch_leaves', 'spruce_leaves', 'vine', 'grass', 'short_grass', 'tall_grass_top', 'tall_grass_bottom',
        'fern', 'large_fern_top', 'large_fern_bottom', 'lily_pad', 'water_still', 'water_flow', 'sugar_cane', 'attached_melon_stem',
        'melon_stem', 'pumpkin_stem'}

# Імена з Minecraft → файли VoxeLibre.
VL = {
    'deepslate': 'mcl_deepslate', 'deepslate_top': 'mcl_deepslate_top', 'cobbled_deepslate': 'mcl_cobbled_deepslate',
    'polished_deepslate': 'mcl_polished_deepslate', 'deepslate_bricks': 'mcl_deepslate_bricks', 'deepslate_tiles': 'mcl_deepslate_tiles',
    'cracked_deepslate_bricks': 'mcl_cracked_deepslate_bricks', 'cracked_deepslate_tiles': 'mcl_cracked_deepslate_tiles',
    'chiseled_deepslate': 'mcl_chiseled_deepslate', 'tuff': 'mcl_deepslate_tuff',
    **{f'deepslate_{o}_ore': f'mcl_deepslate_{o}_ore' for o in ['coal', 'copper', 'diamond', 'emerald', 'gold', 'iron', 'lapis', 'redstone']},
    'calcite': 'mcl_amethyst_calcite_block', 'amethyst_block': 'mcl_amethyst_amethyst_block',
    'budding_amethyst': 'mcl_amethyst_budding_amethyst', 'tinted_glass': 'mcl_amethyst_tinted_glass',
    'copper_block': 'mcl_copper_block', 'cut_copper': 'mcl_copper_block_cut', 'raw_copper_block': 'mcl_copper_block_raw',
    'exposed_copper': 'mcl_copper_exposed', 'exposed_cut_copper': 'mcl_copper_exposed_cut',
    'weathered_copper': 'mcl_copper_weathered', 'weathered_cut_copper': 'mcl_copper_weathered_cut',
    'oxidized_copper': 'mcl_copper_oxidized', 'oxidized_cut_copper': 'mcl_copper_oxidized_cut', 'copper_ore': 'mcl_copper_ore',
    'sculk': 'mcl_sculk_sculk', 'sculk_vein': 'mcl_sculk_vein',
    **{f'sculk_{b}_{f}': f'mcl_sculk_{b}_{f}' for b in ['catalyst', 'sensor', 'shrieker'] for f in ['top', 'side', 'bottom']},
    'mud': 'mcl_mud', 'mud_bricks': 'mcl_mud_bricks', 'packed_mud': 'mcl_mud_packed_mud',
    'mangrove_log': 'mcl_mangrove_log', 'mangrove_log_top': 'mcl_mangrove_log_top', 'mangrove_planks': 'mcl_mangrove_planks',
    'mangrove_leaves': 'mcl_mangrove_leaves', 'stripped_mangrove_log': 'mcl_stripped_mangrove_log_side',
    'stripped_mangrove_log_top': 'mcl_stripped_mangrove_log_top',
    'cherry_log': 'mcl_cherry_blossom_log', 'cherry_log_top': 'mcl_cherry_blossom_log_top', 'cherry_planks': 'mcl_cherry_blossom_planks',
    'cherry_leaves': 'mcl_cherry_blossom_leaves', 'stripped_cherry_log': 'mcl_cherry_blossom_log_stripped',
    'stripped_cherry_log_top': 'mcl_cherry_blossom_log_top_stripped',
    'bamboo_block': 'mcl_bamboo_bamboo_block', 'stripped_bamboo_block': 'mcl_bamboo_bamboo_block_stripped',
    'bamboo_planks': 'mcl_bamboo_bamboo_plank', 'bamboo_mosaic': 'mcl_bamboo_bamboo_plank_mosaic',
}

tiles = {}
def add(name, path):
    im = Image.open(path).convert('RGBA')
    w, h = im.size
    if w < S or h < w or w % S: return
    im = im.crop((0, 0, w, w))  # анімація: перший кадр
    if w != S: im = im.resize((S, S), Image.NEAREST)
    tiles[name] = im

src = os.path.join(pp, 'assets', 'minecraft', 'textures', 'block')
for f in sorted(os.listdir(src)):
    if f.endswith('.png'): add(f[:-4], os.path.join(src, f))
for name, f in VL.items():
    if name in tiles: continue
    p = os.path.join(vl, 'textures', f + '.png')
    if os.path.exists(p): add(name, p)
    else: print('немає у VoxeLibre:', f)

names = sorted(tiles)
cols = 32
rows = (len(names) + cols - 1) // cols
sheet = Image.new('RGBA', (cols * S, rows * S))
index = {}
for i, n in enumerate(names):
    sheet.paste(tiles[n], ((i % cols) * S, (i // cols) * S))
    px = [tiles[n].getpixel((x, y)) for y in range(S) for x in range(S)]
    grey = all(abs(r - g) < 12 and abs(g - b) < 12 for r, g, b, a in px if a)
    index[n] = [i, 1] if n in TINT and grey else [i]
sheet.save(os.path.join(out, 'blocks.png'), optimize=True)
with open(os.path.join(out, 'blocks.json'), 'w') as fh:
    json.dump({'size': S, 'cols': cols, 'tiles': index}, fh, separators=(',', ':'))
print(len(names), 'текстур,', os.path.getsize(os.path.join(out, 'blocks.png')) // 1024, 'КБ')
