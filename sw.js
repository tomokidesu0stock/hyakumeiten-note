/* 百名店ノート service worker
   アプリ本体は「ネット優先・つながらないときだけ保存済みを使う」。更新が必ず届くようにする。 */
var VERSION = 'v1.6.0';
var SHELL = ['./', './index.html', './css/app.css', './js/app.js', './js/data.js', './js/cloud.js', './js/osm.js', './data/osm/index.json', './data/osm/hyakumeiten-pos.json','./data/osm/stations.json', './js/firebase-config.js',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css','./vendor/maplibre/maplibre-gl.js','./vendor/maplibre/maplibre-gl.css','./vendor/maplibre/leaflet-maplibre-gl.js', './vendor/jszip/jszip.min.js',
  './manifest.webmanifest', './data/lists/index.json', './icons/icon-192.png', './icons/icon-512.png'];
var CDN = ['https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js', 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js'];
var SHELL_CACHE = 'shell-' + VERSION, TILE_CACHE = 'tiles-v1';

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(SHELL_CACHE).then(function(c){
    // cache:'reload' でブラウザの一時保存を通さず、必ずサーバーから最新を取る
    return c.addAll(SHELL.map(function(u){ return new Request(u, {cache:'reload'}); }))
      .then(function(){ return Promise.all(CDN.map(function(u){ return c.add(u).catch(function(){}); })); });
  }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k!==SHELL_CACHE && k!==TILE_CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener('fetch', function(e){
  var req = e.request; if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // 地図タイル：保存済みを先に出し、裏で更新
  if (url.hostname === 'cyberjapandata.gsi.go.jp' || url.hostname === 'tiles.openfreemap.org'){
    e.respondWith(caches.open(TILE_CACHE).then(function(c){ return c.match(req).then(function(hit){
      var net = fetch(req).then(function(r){ if (r && (r.ok || r.type==='opaque')) c.put(req, r.clone()); return r; }).catch(function(){ return hit; });
      return hit || net;
    }); }));
    return;
  }
  // ログイン・データベース・住所検索・フォントは常にネットワーク
  if (/googleapis\.com$|firebaseapp\.com$|firebaseio\.com$|nominatim/.test(url.hostname) || url.hostname.indexOf('fonts.g')===0) return;
  // Firebase の SDK（版番号つきで中身が変わらない）は保存済み優先
  if (CDN.indexOf(req.url) >= 0){
    e.respondWith(caches.match(req).then(function(hit){ return hit || fetch(req).then(function(r){ if (r.ok){ var cp=r.clone(); caches.open(SHELL_CACHE).then(function(c){ c.put(req, cp); }); } return r; }); }));
    return;
  }
  if (url.origin !== location.origin) return;
  // アプリ本体と店舗データ：ネット優先（一時保存は確認してから使う）、オフラインなら保存済み
  e.respondWith(fetch(req, {cache:'no-cache'}).then(function(r){
    if (r && r.ok){ var cp = r.clone(); caches.open(SHELL_CACHE).then(function(c){ c.put(req, cp); }); }
    return r;
  }).catch(function(){
    return caches.match(req, {ignoreSearch: true}).then(function(hit){ return hit || caches.match('./index.html'); });
  }));
});
