/* 百名店ノート — osm.js
   OpenStreetMap から取り出した飲食店データ（data/osm/）を、地図の見えている範囲だけ読み込む。
   © OpenStreetMap contributors（ODbL） */
(function(){
'use strict';
var CELL = 0.02; // 約2km四方
var O = window.OSM = {
  index: null, cells: {}, loading: {}, pos: null,
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
  return fetch('data/osm/hyakumeiten-pos.json').then(function(r){ return r.ok ? r.json() : {}; }).then(function(j){ O.pos=j||{}; return O.pos; }).catch(function(){ O.pos={}; return O.pos; });
};
O.has = function(k){ return !!(O.index && O.index.cells && O.index.cells[k]); };
O.loadCell = function(k){
  if (O.cells[k]) return Promise.resolve(O.cells[k]);
  if (!O.has(k)) return Promise.resolve([]);
  if (O.loading[k]) return O.loading[k];
  O.loading[k] = fetch('data/osm/cells/'+k+'.json').then(function(r){ return r.json(); }).then(function(arr){
    var pts = arr.map(function(a){ return {id:a[0], lat:a[1], lng:a[2], name:a[3], cat:a[4], cu:a[5]||'', h:a[6]||'', st:a[7]||'', addr:a[8]||''}; });
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
O.gmapsURL = function(p){ return 'https://www.google.com/maps/search/'+encodeURIComponent(p.name)+'/@'+p.lat+','+p.lng+',18z'; };
O.tabelogURL = function(p){ return 'https://tabelog.com/rstLst/?vs=1&sw='+encodeURIComponent(p.name); };
})();
