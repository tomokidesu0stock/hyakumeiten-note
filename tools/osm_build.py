"""OpenFreeMap（OSM）から取り出した飲食店を、アプリ用の約2km区画ファイルに加工する。
入力: ofm-*.json（ブラウザで書き出したもの）, 任意で osm-*.json（Overpass、ジャンル・営業時間の補完用）
出力: hyakumeiten-note/data/osm/index.json, cells/*.json, hyakumeiten-pos.json
"""
import json, glob, math, re, sys, unicodedata, hashlib, os
from collections import defaultdict

SRC = sys.argv[1]
OUT = '/home/claude/hyakumeiten-note/data/osm'
CELL = 0.02
AREAS = {'kanto': '関東', 'kansai': '関西・三重'}
OLD_AREA = {'tokyo23': ('kanto', '東京都'), 'kyoto': ('kansai', '京都府'), 'ise': ('kansai', '三重県')}

def norm(s):
    s = unicodedata.normalize('NFKC', s or '').lower()
    s = re.sub(r'[\s・･\-‐ー－―〜~\'’"“”「」『』()（）［］\[\]&＆.,、。!！?？/／]+', '', s)
    return s

def dist_m(a, b, c, d):
    x = (d - b) * math.cos(math.radians((a + c) / 2)) * 111320
    y = (c - a) * 110540
    return math.hypot(x, y)

# ---- ジャンル分類（OSMのclass＋店名のキーワード）
KW = [
    ('r', r'ラーメン|日高屋|一蘭|天下一品|幸楽苑|らーめん|拉麺|中華そば|つけ麺|つけめん|担々麺|タンメン|麺屋|麺処|ramen'),
    ('c', r'珈琲|コーヒー|ドトール|スターバックス|タリーズ|コメダ|ベローチェ|ルノアール|プロント|サンマルク|喫茶|カフェ|cafe|café|coffee|茶房|サロン・?ド・?テ|kissa'),
    ('s', r'(?<!ジャ)(?<!ス)パン(?!ダ|チ|ツ|ク)|ミスタードーナツ|サーティワン|銀だこ|ベーカリー|bakery|boulangerie|ケーキ|洋菓子|パティスリー|patisserie|和菓子|甘味|スイーツ|ドーナツ|クレープ|ジェラート|アイス|プリン|菓子|餅|団子|たい焼|大福'),
    ('i', r'居酒屋|酒場|立ち?飲み|やきとん|大衆酒|酒房|バー$|^bar|ワインバー|ビアホール|ビストロバル|izakaya'),
    ('a', r'中華|中国|飯店|菜館|酒家|飯館|酒楼|点心|火鍋|刀削麺|ガパオ|ナシゴレン|ケバブ|トルコ|メキシ|タコス|餃子|台湾|韓国|焼肉|サムギョプサル|タイ料理|ベトナム|インド|カレー|curry|ネパール|アジア|四川|上海|広東|小籠包|麻婆|フォー|ビリヤニ|スリランカ|thai|chinese|korean|indian'),
    ('y', r'イタリア|デニーズ|ガスト|ジョナサン|ロイヤルホスト|サイゼリヤ|ココス|ビストロ|ブラッスリー|ワイン|カレーハウス|洋食屋|レストラン|トラットリア|リストランテ|オステリア|ピッツァ|ピザ|pizza|フレンチ|ビストロ|bistro|ブラッスリー|洋食|グリル|ハンバーグ|ステーキ|steak|バーガー|burger|パスタ|スペイン|バル$|trattoria|osteria|ristorante|french|italian|オムライス|キッチン'),
    ('w', r'寿司|鮨|すし|割烹|小料理|炉端|ろばた|釜飯|ほうとう|ちゃんこ|もつ|ホルモン|牛丼|吉野家|すき家|松屋|なか卯|天丼|てんや|弁当|おむすび|おにぎり|鮓|そば|蕎麦|うどん|饂飩|天ぷら|天麩羅|てんぷら|とんかつ|豚カツ|かつ|鰻|うなぎ|焼鳥|焼き鳥|やきとり|割烹|懐石|料亭|和食|日本料理|定食|食堂|丼|お好み焼|もんじゃ|たこ焼|おでん|串|しゃぶ|すき焼|魚|海鮮|牛たん|牛タン|ふぐ|鍋|おばんざい|京料理|湯葉|豆腐|鶏'),
]
# チェーン店の名前は先に判定する
CHAIN = [
    ('f', r'マクドナルド|mcdonald|モスバーガー|mos ?burger|ケンタッキー|kfc|ロッテリア|フレッシュネス|バーガーキング|burger king|サブウェイ|subway|ファーストキッチン|ウェンディーズ|wendy|ドミノ|ピザーラ|ピザハット|銀だこ'),
    ('i', r'鳥貴族|鳥メロ|串カツ田中|磯丸水産|白木屋|笑笑|魚民|(?<!焼肉の)和民|わたみ|庄や|天狗|つぼ八|塚田農場|八剣伝|や台ずし|金の蔵'),
    ('w', r'丸亀製麺|はなまるうどん|富士そば|小諸そば|ゆで太郎|大戸屋|やよい軒|ねぎし|木曽路|かごの屋|華屋与兵衛|和食さと|がってん寿司|スシロー|くら寿司|かっぱ寿司|はま寿司|銚子丸|魚べい|元気寿司|かに道楽|甲羅|松のや|かつや|さぼてん|とんでん|夢庵|藍屋|てんや'),
    ('r', r'福しん|日高屋|一風堂|来来亭|リンガーハット|afuri|武蔵家|蒙古タンメン|天一|一蘭|ばんから|花月嵐|ちゃんぽん'),
    ('a', r'牛角|安楽亭|叙々苑|焼肉ライク|ワンカルビ|ココイチ|coco壱|ゴーゴーカレー|バーミヤン|大阪王将|王将|珍来'),
    ('y', r'ペッパーランチ|いきなりステーキ|びっくりドンキー|ビッグボーイ|big boy|tony roma|kua.?aina|ジョリーパスタ|洋麺屋|五右衛門(?!ラーメン)|鎌倉パスタ'),
    ('s', r'レオニダス|ゴディバ|godiva|不二家(?!レストラン)|シャトレーゼ|コージーコーナー|ピエール.?エルメ'),
]
# 元の一覧で決まらなかったときの、広めの手がかり
GENERIC = [
    ('i', r'ダイニングバー|ダイニング・バー|dining ?bar|ブルワリー|brewery|brewing|ビール|beer|craft|タップルーム|taproom|tavern|sake'),
    ('w', r'寿し|sushi|soba|udon|tempura|tonkatsu|yakitori|unagi|鉄板|teppan|沖縄|ソーキ|鳥|鯛|蟹|牛かつ|いろり|ごはん処|御食事処|お食事処|めし'),
    ('r', r'家系|麺|noodle|ヌードル'),
    ('a', r'カルビ|ハノイ|ホイアン|サイゴン|メナム|バンコク|ビビンバ|冷麺|チヂミ|飲茶|麻辣|蘭州|ビャンビャン|北京|香港|広州|楼$|タージ|マハラジャ|ナマステ|ヒマラヤ|エベレスト|everest|himalaya|namaste|masala|マサラ|tandoor|タンドール|biryani|\\bpho\\b|banh|kebab|taco'),
    ('y', r'スパゲッ?ティ|ナポリタン|pizzeria|ピッツェリア|pasta|enoteca|エノテカ|vino|kitchen|grill|diner|cucina|クチーナ|brasserie|bistrot|gastro|オイスター|oyster'),
    ('s', r'ショコラ|chocolat|gelato|sweets|cake'),
]
KW = CHAIN + KW + GENERIC
KW = [(k, re.compile(p, re.I)) for k, p in KW]
CUISINE = {  # Overpass の cuisine → ジャンル・表示名
    'ramen': ('r', 'ラーメン'), 'noodle': ('r', '麺'), 'soba': ('w', 'そば'), 'udon': ('w', 'うどん'), 'sushi': ('w', '寿司'),
    'japanese': ('w', '和食'), 'tempura': ('w', '天ぷら'), 'tonkatsu': ('w', 'とんかつ'), 'unagi': ('w', 'うなぎ'), 'yakitori': ('w', '焼き鳥'),
    'okonomiyaki': ('w', 'お好み焼き'), 'kaiseki': ('w', '懐石'), 'donburi': ('w', '丼'), 'gyudon': ('w', '牛丼'), 'teishoku': ('w', '定食'),
    'chinese': ('a', '中華'), 'korean': ('a', '韓国'), 'indian': ('a', 'インド'), 'curry': ('a', 'カレー'), 'thai': ('a', 'タイ'), 'vietnamese': ('a', 'ベトナム'),
    'nepalese': ('a', 'ネパール'), 'asian': ('a', 'アジア'), 'yakiniku': ('a', '焼肉'), 'italian': ('y', 'イタリアン'), 'french': ('y', 'フレンチ'),
    'pizza': ('y', 'ピザ'), 'burger': ('y', 'ハンバーガー'), 'steak_house': ('y', 'ステーキ'), 'spanish': ('y', 'スペイン'), 'western': ('y', '洋食'),
    'barbecue': ('a', '焼肉'), 'beef_bowl': ('w', '牛丼'), 'chicken': ('w', '鶏料理'), 'savory_pancakes': ('w', 'お好み焼き'), 'regional': ('w', '郷土料理'),
    'pasta': ('y', 'パスタ'), 'fish': ('w', '魚料理'), 'seafood': ('w', '海鮮'), 'sandwich': ('f', 'サンド'), 'donut': ('s', 'ドーナツ'), 'friture': ('f', '揚げ物'),
    'mexican': ('a', 'メキシコ'), 'american': ('y', 'アメリカン'), 'takoyaki': ('f', 'たこ焼き'), 'tea': ('c', 'お茶'), 'taiwanese': ('a', '台湾'),
    'german': ('y', 'ドイツ'), 'steak': ('y', 'ステーキ'), 'bubble_tea': ('c', 'タピオカ'), 'fried_food': ('w', '揚げ物'), 'gyoza': ('a', '餃子'),
    'kebab': ('a', 'ケバブ'), 'turkish': ('a', 'トルコ'), 'crepe': ('s', 'クレープ'), 'coffee': ('c', 'コーヒー'), 'tantanmen': ('r', '担々麺'),
    'teppanyaki': ('w', '鉄板焼き'), 'fried_chicken': ('f', 'からあげ'), 'hot_dog': ('f', 'ホットドッグ'), 'pancake': ('s', 'パンケーキ'),
    'kushikatsu': ('i', '串カツ'), 'kushiage': ('i', '串揚げ'), 'oden': ('w', 'おでん'), 'shabu-shabu': ('w', 'しゃぶしゃぶ'), 'sukiyaki': ('w', 'すき焼き'),
    'tonkotsu': ('r', 'とんこつ'), 'gyutan': ('w', '牛たん'), 'motsunabe': ('w', 'もつ鍋'), 'tapas': ('y', 'タパス'), 'greek': ('y', 'ギリシャ'),
    'sri_lankan': ('a', 'スリランカ'), 'indonesian': ('a', 'インドネシア'), 'malaysian': ('a', 'マレーシア'), 'filipino': ('a', 'フィリピン'),
    'chinese_noodle': ('r', '中華そば'), 'tsukemen': ('r', 'つけ麺'), 'dumpling': ('a', '餃子'), 'bagel': ('s', 'ベーグル'), 'cake_shop': ('s', 'ケーキ'),
    '居酒屋': ('i', '居酒屋'), 'お好み焼き': ('w', 'お好み焼き'), 'たこ焼き': ('f', 'たこ焼き'), '焼肉': ('a', '焼肉'), '餃子': ('a', '餃子'), 'うなぎ': ('w', 'うなぎ'),
    '串かつ': ('i', '串カツ'), '焼き鳥': ('w', '焼き鳥'), '定食': ('w', '定食'), 'もつ鍋': ('w', 'もつ鍋'), 'オムライス': ('y', 'オムライス'), 'パン': ('s', 'パン'),
    'okonomiyaki_': ('w', 'お好み焼き'),
    'fries': ('f', 'ポテト'), 'hawaiian': ('y', 'ハワイアン'), 'とんかつ': ('w', 'とんかつ'), 'grill': ('y', 'グリル'), 'bento': ('w', '弁当'), 'salad': ('y', 'サラダ'),
    'ラーメン': ('r', 'ラーメン'), 'italian_pizza': ('y', 'ピザ'), 'brazilian': ('y', 'ブラジル'), 'russian': ('y', 'ロシア'), 'onigiri': ('w', 'おにぎり'),
    'noodles': ('r', '麺'), 'okinawan': ('w', '沖縄料理'), 'okinawa': ('w', '沖縄料理'), 'karaage': ('f', 'からあげ'), 'bistro': ('y', 'ビストロ'), 'wine': ('i', 'ワイン'),
    '中華': ('a', '中華'), 'eel': ('w', 'うなぎ'), '鰻': ('w', 'うなぎ'), 'tenpura': ('w', '天ぷら'), 'cutlet': ('w', 'とんかつ'), 'teahouse': ('c', '茶房'),
    'british': ('y', 'イギリス'), 'もんじゃ焼き': ('w', 'もんじゃ'), 'monja': ('w', 'もんじゃ'), 'tex-mex': ('a', 'メキシコ'), 'カレー': ('a', 'カレー'),
    'cafe': ('c', 'カフェ'), 'fish_and_chips': ('y', 'フィッシュ&チップス'), 'singaporean': ('a', 'シンガポール'), 'fugu': ('w', 'ふぐ'),
    'mediterranean': ('y', '地中海'), 'persian': ('a', 'ペルシャ'), 'ステーキ': ('y', 'ステーキ'), 'diner': ('y', 'ダイナー'), 'juice': ('c', 'ジュース'),
    'coffee_shop': ('c', 'コーヒー'), 'izakaya': ('i', '居酒屋'), 'cake': ('s', 'ケーキ'), 'dessert': ('s', 'スイーツ'), 'ice_cream': ('s', 'アイス'), 'bakery': ('s', 'パン'),
}

def classify(cls, sub, name):
    n = name or ''
    if cls in ('bakery', 'ice_cream', 'confectionery', 'pastry') or sub in ('bakery', 'confectionery', 'pastry', 'ice_cream'):
        return 's'
    if cls in ('bar', 'beer', 'pub', 'biergarten') or sub in ('bar', 'pub', 'biergarten', 'nightclub'):
        return 'i'
    for ix, (k, rx) in enumerate(KW):
        if rx.search(n):
            if cls == 'cafe' and k not in ('s', 'c'):
                continue
            if cls == 'fast_food' and k == 'y' and ix >= len(CHAIN):
                return 'f'
            return k
    if cls == 'cafe': return 'c'
    if cls == 'fast_food': return 'f'
    return 'o'

def stable_id(name, lat, lon):
    h = hashlib.sha1(f'{norm(name)}|{round(lat,4)}|{round(lon,4)}'.encode()).hexdigest()
    return h[:10]

# ---- 読み込み
pts = []
for f in sorted(glob.glob(os.path.join(SRC, '*.json'))):
    try: j = json.load(open(f, encoding='utf-8'))
    except Exception as e: print('skip', f, e); continue
    if str(j.get('file', '')).startswith('ofm-'):
        for t in j['tiles']:
            for lat, lon, name, cls, sub, alt in t['p']:
                ar, pf = OLD_AREA[t['a']]
                pts.append({'lat': lat, 'lon': lon, 'name': name, 'cls': cls, 'sub': sub, 'area': ar, 'pref': pf, 'alt': alt})
print('raw points', len(pts))

# 区画の境目で重複した点をまとめる（同じ名前で25m以内）
grid = defaultdict(list); uniq = []
for p in pts:
    k = (round(p['lat'], 3), round(p['lon'], 3), norm(p['name']))
    dup = False
    for q in grid[k]:
        if dist_m(p['lat'], p['lon'], q['lat'], q['lon']) < 25: dup = True; break
    if not dup:
        grid[k].append(p); uniq.append(p)
print('unique', len(uniq))

# ---- Overpass / Geofabrik（あれば）で ジャンル・営業時間を補う
def mkaddr(e):
    tg = e['tg']
    q = tg.get('addr:quarter') or tg.get('addr:suburb') or tg.get('addr:neighbourhood') or ''
    c = e.get('city') or ''
    if q and c and q.startswith(c): c = ''
    if q and c and q in c: q = ''
    return (c + ' ' + q).strip()
ov = []
for f in sorted(glob.glob(os.path.join(SRC, '*.json'))):
    try: j = json.load(open(f, encoding='utf-8'))
    except Exception: continue
    if str(j.get('file', '')).startswith('osm-') and 'elements' in j:
        gf = str(j.get('file', '')).startswith('osm-gf')
        region = j.get('region')
        for el in j['elements']:
            oid, lat, lon, tg = el[:4]
            pf = el[4] if len(el) > 4 else ''
            city = el[5] if len(el) > 5 else ''
            if region == 'kanto' and not pf and 35.4 < lat < 35.95 and 138.9 < lon < 140.0: pf = '東京都'  # 東京都の境界は島しょ部が外れて組めないため
            if region and not pf: continue
            nm = tg.get('name:ja') or tg.get('name')
            if nm: ov.append({'oid': oid, 'lat': lat, 'lon': lon, 'tg': tg, 'gf': gf, 'area': region, 'pref': pf, 'city': city, 'used': False,
                              'keys': {norm(x) for x in (tg.get('name'), tg.get('name:ja')) if x}})
ovi = defaultdict(list)
for e in ov:
    for k in e['keys']: ovi[k].append(e)
enriched = 0
for p in uniq:
    for e in ovi.get(norm(p['name']), []):
        if dist_m(p['lat'], p['lon'], e['lat'], e['lon']) < 80:
            e['used'] = True
            if p.get('_en'): continue
            tg = e['tg']
            cu = (tg.get('cuisine') or '').split(';')[0].strip().lower().replace(' ', '_')
            if cu in CUISINE: p['cu'] = CUISINE[cu][1]; p['catHint'] = CUISINE[cu][0]
            if tg.get('opening_hours'): p['h'] = tg['opening_hours'][:160]
            p['addr'] = mkaddr(e)
            if e.get('pref'): p['pref'] = e['pref']
            p['_en'] = True; enriched += 1
# Geofabrik にだけある名前つきのお店を追加する
added = 0
seen = defaultdict(list)
for e in ov:
    if not e['gf'] or e['used'] or not e['area']: continue
    k = (round(e['lat'], 3), round(e['lon'], 3), min(e['keys']))
    if any(dist_m(e['lat'], e['lon'], q['lat'], q['lon']) < 25 for q in seen[k]): continue
    seen[k].append(e)
    tg = e['tg']; nm = tg.get('name') or tg.get('name:ja')
    cls = tg.get('amenity') or tg.get('shop') or ''
    p = {'lat': e['lat'], 'lon': e['lon'], 'name': nm, 'cls': cls, 'sub': cls, 'area': e['area'], 'alt': tg.get('name:ja') if tg.get('name:ja') != nm else ''}
    cu = (tg.get('cuisine') or '').split(';')[0].strip().lower().replace(' ', '_')
    if cu in CUISINE: p['cu'] = CUISINE[cu][1]; p['catHint'] = CUISINE[cu][0]
    if tg.get('opening_hours'): p['h'] = tg['opening_hours'][:160]
    p['addr'] = mkaddr(e); p['pref'] = e.get('pref', '')
    uniq.append(p); added += 1
print('added from geofabrik', added)
print('enriched by overpass', enriched)

for p in uniq:
    p['name'] = (p['name'] or '').split(';')[0].strip() or p['name']
    base = classify(p['cls'], p['sub'], p['name'] + ' ' + (p.get('alt') or ''))
    hint = p.get('catHint')
    if p['cls'] in ('bar', 'pub', 'biergarten') or p['sub'] in ('bar', 'pub', 'biergarten'): hint = 'i'
    elif p['cls'] == 'fast_food' and hint in ('y', 'w', None) and base in ('f', 'y'): hint = 'f'
    elif p['cls'] in ('bakery', 'confectionery', 'pastry', 'ice_cream') or p['sub'] in ('bakery', 'confectionery', 'pastry', 'ice_cream'): hint = 's'
    p['cat'] = hint or base
    p['id'] = stable_id(p['name'], p['lat'], p['lon'])

# ---- 百名店と照合して正確な位置を出す
sys.path.insert(0, '/home/claude')
stores = []
dj = open('/home/claude/hyakumeiten-note/js/data.js', encoding='utf-8').read()
stations = json.loads(re.search(r'window\.STATIONS = (\{[\s\S]*?\});', dj).group(1))
st2 = json.load(open(os.path.join(OUT, 'stations.json'), encoding='utf-8')) if os.path.exists(os.path.join(OUT, 'stations.json')) else {}
raw = re.search(r'window\.KISSA_2026_RAW = `([\s\S]*?)`;', dj).group(1).split('\n')
for i, l in enumerate(raw):
    c = l.split('|')
    st = st2.get(c[1] + '|' + c[2]) or stations.get(c[2])
    stores.append({'id': f'k2026-{i+1}', 'name': c[0], 'pref': c[1], 'area': c[2], 'lat': st[0] if st else None, 'lon': st[1] if st else None})
for f in glob.glob('/home/claude/hyakumeiten-note/data/lists/*.json'):
    if f.endswith('index.json'): continue
    j = json.load(open(f, encoding='utf-8'))
    for x in j['stores']:
        rid = x['path'].split('/')[-1]
        st = st2.get(x['pref'] + '|' + x['area']) or stations.get(x['area'])
        stores.append({'id': f"tl-{j['slug']}-{rid}", 'name': x['name'], 'pref': x['pref'], 'area': x['area'], 'lat': st[0] if st else None, 'lon': st[1] if st else None})

AREA_PREF = {'tokyo23': '東京都', 'kyoto': '京都府', 'ise': '三重県'}
def strip_paren(n):
    return re.sub(r'[\(（][^)）]*[\)）]', ' ', unicodedata.normalize('NFKC', n or '')).strip()
def branch_split(n):
    """('本体', '支店名' or '') — 最後の空白区切りが「〜店／本館／別館」なら支店名とみなす"""
    t = strip_paren(n).split()
    if len(t) >= 2 and re.search(r'(店|本館|別館)$', t[-1]): return norm(' '.join(t[:-1])), norm(t[-1])
    return norm(' '.join(t)), ''
osm_idx = defaultdict(list)
for p in uniq:
    body, br = branch_split(p['name'])
    p['_full'] = norm(strip_paren(p['name'])); p['_body'] = body; p['_br'] = br
    osm_idx[p['_full']].append(p)
    if body != p['_full']: osm_idx[body].append(p)
pos = {}; matched = 0
for s in stores:
    full = norm(strip_paren(s['name'])); body, br = branch_split(s['name'])
    cands = {id(p): p for k in {full, body} for p in osm_idx.get(k, []) if p.get('pref') == s['pref']}
    ok = []
    for p in cands.values():
        same = (p['_full'] == full) or (p['_full'] == body) or (p['_body'] == full) or (p['_body'] == body)
        if not same: continue
        if br and p['_br'] and br != p['_br'] and not (br.endswith('本店') and p['_br'].endswith('本店')): continue  # 別の支店
        if len(body) < 3: continue
        if br and not p['_br'] and s['lat'] is None and p['_full'] != full: continue  # 支店名あり×OSMは支店名なし×駅も不明 → 別の支店かもしれない
        # 市区町村名がわかる店は、OSM側の住所と市区町村が一致すること
        if re.search(r'(市|区|町|村)$', s['area'] or '') and p.get('addr') and s['area'] not in p['addr'] and not (p['addr'].split(' ')[0] in s['area']): continue
        # 駅の位置がわからないときは、短い店名（よくある名前）は決めない
        if s['lat'] is None and not re.search(r'(市|区|町|村)$', s['area'] or '') and len(body) < 4: continue
        d = dist_m(s['lat'], s['lon'], p['lat'], p['lon']) if s['lat'] is not None else None
        if d is None or d < 2500: ok.append((d if d is not None else 1e9, p))
    if not ok: continue
    ok.sort(key=lambda x: x[0])
    if s['lat'] is None and len(ok) > 1: continue  # 駅が分からず候補が複数なら決めない
    p = ok[0][1]
    pos[s['id']] = [p['lat'], p['lon']]
    p.setdefault('st', s['id']); matched += 1
print('hyakumeiten matched', matched, 'of', len(stores))

# ---- 区画ファイルに分割
PREFS = ['東京都', '神奈川県', '千葉県', '埼玉県', '茨城県', '栃木県', '群馬県', '京都府', '大阪府', '兵庫県', '滋賀県', '奈良県', '和歌山県', '三重県']
os.makedirs(os.path.join(OUT, 'cells'), exist_ok=True)
for f in glob.glob(os.path.join(OUT, 'cells', '*.json')): os.remove(f)
cells = defaultdict(list)
for p in uniq:
    k = f"{math.floor(p['lat']/CELL)}_{math.floor(p['lon']/CELL)}"
    cells[k].append([p['id'], p['lat'], p['lon'], p['name'], p['cat'], p.get('cu', ''), p.get('h', ''), p.get('st', ''), p.get('addr', ''), PREFS.index(p['pref']) if p.get('pref') in PREFS else -1])
for k, arr in cells.items():
    arr.sort(key=lambda a: (a[4], a[3]))
    json.dump(arr, open(os.path.join(OUT, 'cells', k + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
cat_counts = defaultdict(int)
for p in uniq: cat_counts[p['cat']] += 1
area_counts = defaultdict(int)
for p in uniq: area_counts[p['area']] += 1
idx = {'cell': CELL, 'updated': '2026-10-19', 'source': 'OpenStreetMap (OpenFreeMap 2026-10-11, Geofabrik 2026-10-19)', 'license': 'ODbL — © OpenStreetMap contributors',
       'areas': {a: {'name': AREAS[a], 'count': area_counts[a]} for a in AREAS}, 'cats': cat_counts, 'prefs': PREFS, 'cells': {k: len(v) for k, v in cells.items()}}
json.dump(idx, open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
json.dump(pos, open(os.path.join(OUT, 'hyakumeiten-pos.json'), 'w', encoding='utf-8'), separators=(',', ':'))
tot = sum(os.path.getsize(os.path.join(OUT, 'cells', f)) for f in os.listdir(os.path.join(OUT, 'cells')))
print('cells', len(cells), 'size MB', round(tot / 1e6, 1), 'max cell', max(len(v) for v in cells.values()))
print('areas', dict(area_counts)); print('cats', dict(cat_counts))
