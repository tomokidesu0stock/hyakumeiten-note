/* 百名店ノート service worker — アプリ本体をキャッシュしてオフラインでも開けるようにする */
var VERSION = 'v1.3.0';
var SHELL = ['./', './index.html', './css/app.css', './js/app.js', './js/data.js', './js/cloud.js', './js/firebase-config.js', './manifest.webmanifest', './data/lists/index.json', './icons/icon-192.png', './icons/icon-512.png'];
var CDN = ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js', 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open('shell-'+VERSION).then(function(c){ return c.addAll(SHELL).then(function(){ return Promise.all(CDN.map(function(u){ return c.add(u).catch(function(){}); })); }); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){ return Promise.all(keys.filter(function(k){ return k.indexOf(VERSION)<0; }).map(function(k){ return caches.delete(k); })); }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // 地図タイル・ジオコーディング・フォントは都度ネットワーク（タイルは控えめにキャッシュ）
  if (url.hostname.indexOf('cartocdn.com')>=0){
    e.respondWith(caches.open('tiles-'+VERSION).then(function(c){ return c.match(e.request).then(function(hit){ var net=fetch(e.request).then(function(r){ if (r.ok) c.put(e.request, r.clone()); return r; }).catch(function(){ return hit; }); return hit || net; }); }));
    return;
  }
  if (url.hostname.indexOf('nominatim')>=0 || url.hostname.indexOf('fonts.g')>=0) return;
  // Firebase（ログイン・データベース）は常にネットワークへ
  if (/googleapis\.com$|firebaseapp\.com$|firebaseio\.com$/.test(url.hostname)) return;
  // 設定ファイルは更新をすぐ反映したいのでネットワーク優先
  if (url.origin===location.origin && /firebase-config\.js$/.test(url.pathname)){ e.respondWith(fetch(e.request).catch(function(){ return caches.match(e.request); })); return; }
  // アプリ本体: キャッシュ優先、裏で更新
  e.respondWith(caches.match(e.request).then(function(hit){
    var net = fetch(e.request).then(function(r){ if (r && r.ok && (url.origin===location.origin || CDN.indexOf(e.request.url)>=0)) caches.open('shell-'+VERSION).then(function(c){ c.put(e.request, r.clone()); }); return r; }).catch(function(){ return hit; });
    return hit || net;
  }));
});
