/* 百名店ノート — osm.js
   OpenStreetMap から取り出した飲食店データ（data/osm/）を、地図の見えている範囲だけ読み込む。
   © OpenStreetMap contributors（ODbL） */
(function(){
'use strict';
var CELL = 0.02; // 約2km四方
var O = window.OSM = {
  index: null, cells: {}, loading: {}, pos: null, st: null, // st: 「都道府県|駅名」→ 駅の位置（OSM）
  CATS: {
    c:{label:'カフェ・喫茶', color:'#b07a3c'},
    w:{label:'和食', color:'#c8553d'},
    r:{label:'ラーメン・麺', color:'#e0a458'},
    a:{label:'中華・アジア', color:'#8e5ea2'},
    y:{label:'洋食', color:'#3e7cb1'},
    i:{label:'居酒屋・バー', color:'#2f855a'},
    s:{label:'パン・スイーツ', color:'#d6729c'},
    f:{label:'ファストフード', color:'#7d8597'},
    o:{label:'その他', color:'#9aa39b'}
  }
};
O.key = function(lat, lng){ return Math.floor(lat/CELL)+'_'+Math.floor(lng/CELL); };
O.loadIndex = function(){
  if (O.index) return Promise.resolve(O.index);
  if (O._idx) return O._idx;
  O._idx = fetch('data/osm/index.json').then(function(r){ if(!r.ok) throw new Error('no osm'); return r.json(); }).then(function(j){ O.index=j; return j; }).catch(function(e){ O._idx=null; throw e; });
  return O._idx;
};
// 百名店の正確な位置（OSMの店名と照合したもの）
O.loadPositions = function(){
  if (O.pos) return Promise.resolve(O.pos);
  var st = fetch('data/osm/stations.json').then(function(r){ return r.ok ? r.json() : {}; }).then(function(j){ O.st=j||{}; }).catch(function(){ O.st={}; });
  return st.then(function(){ return fetch('data/osm/hyakumeiten-pos.json'); }).then(function(r){ return r.ok ? r.json() : {}; }).then(function(j){ O.pos=j||{}; return O.pos; }).catch(function(){ O.pos={}; return O.pos; });
};
O.has = function(k){ return !!(O.index && O.index.cells && O.index.cells[k]); };
O.loadCell = function(k){
  if (O.cells[k]) return Promise.resolve(O.cells[k]);
  if (!O.has(k)) return Promise.resolve([]);
  if (O.loading[k]) return O.loading[k];
  O.loading[k] = fetch('data/osm/cells/'+k+'.json').then(function(r){ return r.json(); }).then(function(arr){
    var P = (O.index && O.index.prefs) || [];
    var pts = arr.map(function(a){ return {id:a[0], lat:a[1], lng:a[2], name:a[3], cat:a[4], cu:a[5]||'', h:a[6]||'', st:a[7]||'', addr:a[8]||'', pref:a[9]>=0 ? (P[a[9]]||'') : ''}; });
    O.cells[k] = pts; delete O.loading[k]; return pts;
  }).catch(function(){ delete O.loading[k]; return []; });
  return O.loading[k];
};
O.keysIn = function(s, w, n, e){
  var out=[], a=Math.floor(s/CELL), b=Math.floor(n/CELL), c=Math.floor(w/CELL), d=Math.floor(e/CELL);
  if ((b-a+1)*(d-c+1) > 64) return out; // 広すぎるときは読まない
  for (var i=a;i<=b;i++) for (var j=c;j<=d;j++){ var k=i+'_'+j; if (O.has(k)) out.push(k); }
  return out;
};
O.inBounds = function(s, w, n, e){
  return O.keysIn(s,w,n,e).reduce(function(p,k){ return p.then(function(acc){ return O.loadCell(k).then(function(pts){ return acc.concat(pts.filter(function(p){ return p.lat>=s&&p.lat<=n&&p.lng>=w&&p.lng<=e; })); }); }); }, Promise.resolve([]));
};
O.nearby = function(pos, n, radiusKm){
  radiusKm = radiusKm || 0.5;
  var dLat = radiusKm/111, dLng = radiusKm/(111*Math.cos(pos.lat*Math.PI/180));
  return O.loadIndex().then(function(){ return O.inBounds(pos.lat-dLat, pos.lng-dLng, pos.lat+dLat, pos.lng+dLng); }).then(function(pts){
    var R=6371;
    pts.forEach(function(p){ var x=(p.lng-pos.lng)*Math.PI/180*Math.cos(pos.lat*Math.PI/180), y=(p.lat-pos.lat)*Math.PI/180; p._d=Math.sqrt(x*x+y*y)*R; });
    return pts.filter(function(p){ return p._d<=radiusKm; }).sort(function(a,b){ return a._d-b._d; }).slice(0, n||10);
  }).catch(function(){ return []; });
};
// OSM の opening_hours を日本語っぽく（Mo-Fr 11:00-14:00; Sa off → 月〜金 11:00-14:00 / 土 休み）
O.hoursJa = function(h){
  if (!h) return '';
  var D={Mo:'月',Tu:'火',We:'水',Th:'木',Fr:'金',Sa:'土',Su:'日',PH:'祝'};
  return String(h).replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, function(m){ return D[m]; })
    .replace(/([月火水木金土日祝])-([月火水木金土日祝])/g, '$1〜$2')
    .replace(/([月火水木金土日祝]),(?=[月火水木金土日祝])/g, '$1・')
    .replace(/\b(off|closed)\b/gi, '休み').replace(/24\/7/, '24時間').replace(/\s*;\s*/g, ' / ');
};
// 営業中かどうか（true / false / わからなければ null）。よくある書き方だけ解釈する
var DAYS = ['Mo','Tu','We','Th','Fr','Sa','Su'];
O.week = function(h){
  if (!h) return null;
  h = String(h).trim();
  if (h === '24/7') { var a=[]; for (var i=0;i<7;i++) a.push([[0,1440]]); return a; }
  var week = [[],[],[],[],[],[],[]], any=false;
  var rules = h.split(/\s*(?:;|\|\|)\s*/);
  for (var r=0; r<rules.length; r++){
    var rule = rules[r].trim(); if (!rule) continue;
    var m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?\s*,?\s*)+)?\s*(.*)$/);
    if (!m) return null;
    var dspec = (m[1]||'').trim(), rest = (m[2]||'').trim();
    var days = [];
    if (!dspec) days = [0,1,2,3,4,5,6];
    else {
      var parts = dspec.split(/\s*,\s*/).filter(Boolean), onlyPH = true;
      parts.forEach(function(t){ if (t==='PH') return; onlyPH=false; var ab=t.split('-'), a=DAYS.indexOf(ab[0]), b=ab[1]?DAYS.indexOf(ab[1]):a; if (a<0||b<0) return; for (var d=a;;d=(d+1)%7){ days.push(d); if (d===b) break; } });
      if (onlyPH) continue;  // 祝日だけのルールは無視
    }
    var iv;
    if (/^(off|closed)$/i.test(rest)) iv = [];
    else {
      if (!rest) return null;
      iv = [];
      var ok = rest.split(/\s*,\s*/).every(function(t){
        var x = t.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\+?$/); if (!x) return false;
        var s = +x[1]*60 + +x[2], e = +x[3]*60 + +x[4]; if (e <= s) e += 1440; iv.push([s,e]); return true; });
      if (!ok) return null;
    }
    days.forEach(function(d){ week[d] = iv.slice(); }); any = true;
  }
  return any ? week : null;
};
O.isOpen = function(h, now){
  var w = O.week(h); if (!w) return null;
  now = now || new Date();
  var d = (now.getDay()+6)%7, m = now.getHours()*60 + now.getMinutes(), pd = (d+6)%7;
  if (w[d].some(function(t){ return m>=t[0] && m<t[1]; })) return true;
  if (w[pd].some(function(t){ return t[1]>1440 && m < t[1]-1440; })) return true;
  return false;
};
// 店名で探す（地図の中心のまわり 約10km 四方）
O.search = function(q, center, n){
  var nq = O.norm(q); if (!nq) return Promise.resolve([]);
  var r = 2, ci = Math.floor(center.lat/CELL), cj = Math.floor(center.lng/CELL), keys = [];
  for (var i=ci-r;i<=ci+r;i++) for (var j=cj-r;j<=cj+r;j++){ var k=i+'_'+j; if (O.has(k)) keys.push(k); }
  return Promise.all(keys.map(O.loadCell)).then(function(all){
    var out = [];
    all.forEach(function(pts){ pts.forEach(function(p){ if (!p._n) p._n = O.norm(p.name); if (p._n.indexOf(nq) >= 0 || (p.cu && p.cu.indexOf(q) >= 0)) out.push(p); }); });
    var R = 6371;
    out.forEach(function(p){ var x=(p.lng-center.lng)*Math.PI/180*Math.cos(center.lat*Math.PI/180), y=(p.lat-center.lat)*Math.PI/180; p._d=Math.sqrt(x*x+y*y)*R; });
    out.sort(function(a,b){ return a._d-b._d; });
    return out.slice(0, n||40);
  });
};
O.norm = function(s){ return String(s||'').normalize('NFKC').toLowerCase().replace(/[\s・･\-‐ー－―〜~'’"“”「」『』()（）［］\[\]&＆.,、。!！?？\/／]+/g, ''); };
O.gmapsURL = function(p){ return 'https://www.google.com/maps/search/'+encodeURIComponent(p.name)+'/@'+p.lat+','+p.lng+',18z'; };
O.tabelogURL = function(p){ return 'https://tabelog.com/rstLst/?vs=1&sw='+encodeURIComponent(p.name); };
})();
