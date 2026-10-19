import json, glob, re, unicodedata, math, sys
def sn(s):
    s = unicodedata.normalize('NFKC', s or '')
    s = re.sub(r'[\(（][^)）]*[\)）]', '', s).strip()
    s = re.sub(r'駅$', '', s); s = re.sub(r'^(JR|ＪＲ)\s*', '', s)
    return s.replace(' ', '').replace('ヶ', 'ケ').replace('ヵ', 'カ').replace('之', 'ノ').lower()
def dm(a, b): return math.hypot((a[1]-b[1])*91000, (a[0]-b[0])*111000)
tab = {}
for f in glob.glob('/tmp/osmsrc2/osm-stations-*.json'):
    for nm, lat, lon, op, kind, pf in json.load(open(f))['stations']:
        if not pf and 35.4 < lat < 35.95 and 138.9 < lon < 140.0: pf = '東京都'
        if not pf: continue
        tab.setdefault((pf, sn(nm)), []).append((lat, lon))
res = {}
for k, v in tab.items():
    c = v[0]
    if max(dm(c, x) for x in v) > 3000: continue  # 同じ県に同名の駅が離れてある
    res[k] = (round(sum(x[0] for x in v)/len(v), 5), round(sum(x[1] for x in v)/len(v), 5))
need = {}
for f in glob.glob('/home/claude/hyakumeiten-note/data/lists/*.json'):
    if f.endswith('index.json'): continue
    for x in json.load(open(f))['stores']:
        if x['area'].endswith('駅'): need[(x['pref'], x['area'])] = 1
dj = open('/home/claude/hyakumeiten-note/js/data.js', encoding='utf-8').read()
for l in re.search(r'window\.KISSA_2026_RAW = `([\s\S]*?)`;', dj).group(1).split('\n'):
    c = l.split('|')
    if c[2].endswith('駅'): need[(c[1], c[2])] = 1
PR = {'東京都','神奈川県','千葉県','埼玉県','茨城県','栃木県','群馬県','京都府','大阪府','兵庫県','滋賀県','奈良県','和歌山県','三重県'}
out = {}; miss = []
for (pf, area) in need:
    if pf not in PR: continue
    r = res.get((pf, sn(area)))
    if r: out[pf + '|' + area] = list(r)
    else: miss.append(pf + '|' + area)
inreg = sum(1 for p, a in need if p in PR)
print('stations needed in region', inreg, 'found', len(out), 'miss', len(miss)); print(miss[:30])
json.dump(out, open('/home/claude/hyakumeiten-note/data/osm/stations.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
