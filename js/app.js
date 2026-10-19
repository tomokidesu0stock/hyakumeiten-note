/* 百名店ノート — app.js
   データは端末内（IndexedDB）に保存。バックアップは設定から zip で書き出し・読み込み。 */
(function(){
'use strict';
var $ = function(s, el){ return (el||document).querySelector(s); };
var $$ = function(s, el){ return Array.prototype.slice.call((el||document).querySelectorAll(s)); };
var esc = function(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
var todayStr = function(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
var fmtDate = function(s){ return s ? s.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1/$2/$3') : ''; };
var shortDate = function(s){ return s ? s.slice(5).replace('-','/') : ''; };
var uid = function(p){ return (p||'id')+'-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); };

/* ---------- IndexedDB ---------- */
var DB = (function(){
  var dbp = null;
  function open(){
    if (dbp) return dbp;
    dbp = new Promise(function(res, rej){
      var r = indexedDB.open('hyakumeiten-note', 1);
      r.onupgradeneeded = function(){
        var d = r.result;
        d.createObjectStore('ratings', {keyPath:'storeId'});
        d.createObjectStore('stores', {keyPath:'id'});
        d.createObjectStore('lists', {keyPath:'id'});
        var ph = d.createObjectStore('photos', {keyPath:'id'}); ph.createIndex('storeId','storeId');
        d.createObjectStore('kv', {keyPath:'k'});
      };
      r.onsuccess = function(){ res(r.result); };
      r.onerror = function(){ rej(r.error); };
    });
    return dbp;
  }
  function tx(store, mode, fn){
    return open().then(function(d){ return new Promise(function(res, rej){
      var t = d.transaction(store, mode), s = t.objectStore(store), out = fn(s);
      t.oncomplete = function(){ res(out && out.result !== undefined ? out.result : out); };
      t.onerror = function(){ rej(t.error); };
    }); });
  }
  var self = {
    onChange: null,
    all: function(store){ return tx(store,'readonly',function(s){ return s.getAll(); }); },
    get: function(store,k){ return tx(store,'readonly',function(s){ return s.get(k); }); },
    put: function(store,v,o){
      var sync = !(o && o.noSync);
      if (sync && v && (store==='stores'||store==='lists')) v.updated = Date.now();
      if (sync && store==='kv' && v && String(v.k).indexOf('ov-')===0 && v.v) v.v.updated = Date.now();
      return tx(store,'readwrite',function(s){ s.put(v); return v; }).then(function(r){ if (sync && self.onChange) self.onChange('put', store, v); return r; });
    },
    del: function(store,k,o){
      return tx(store,'readwrite',function(s){ s.delete(k); }).then(function(r){ if (!(o && o.noSync) && self.onChange) self.onChange('del', store, k); return r; });
    },
    byIndex: function(store, idx, v){ return tx(store,'readonly',function(s){ return s.index(idx).getAll(v); }); },
    clear: function(store){ return tx(store,'readwrite',function(s){ s.clear(); }); }
  };
  return self;
})();

/* ---------- state ---------- */
var S = {
  view:'list', tab:'kissa2026', otherList:'', sort:'total', pref:'', vis:'all', q:'',
  ratings:{}, custom:[], lists:[], photoIdx:{}, pos:null, detail:null, rating:null, tl:{}, tlIndex:null, ov:{}, stations:{}, geoQueue:[], geoBusy:false, map:null, layer:null, mapFilter:'tab', statsMode:'me', osmOn:true, osmCats:null
};
var CL = function(){ return window.Cloud || {}; };
function friendSum(id){ var c=CL(); return c.user && c.summary ? c.summary(id) : null; }
function fmtAvg(x){ return x==null ? '–' : (Math.round(x*10)/10).toFixed(1); }
var KISSA = window.KISSA_2026;
var PREF_ORDER = window.PREF_ORDER;
var prefIdx = function(p){ var i = PREF_ORDER.indexOf(p); return i<0?99:i; };

function load(){
  return Promise.all([DB.all('ratings'), DB.all('stores'), DB.all('lists'), DB.all('photos'), DB.get('kv','ui')]).then(function(r){
    S.ratings = {}; r[0].forEach(function(x){ S.ratings[x.storeId]=x; });
    S.custom = r[1]; S.lists = r[2].sort(function(a,b){ return (a.created||0)-(b.created||0); });
    S.photoIdx = {}; r[3].forEach(function(p){ (S.photoIdx[p.storeId] = S.photoIdx[p.storeId]||[]).push(p); });
    Object.keys(S.photoIdx).forEach(function(k){ S.photoIdx[k].sort(function(a,b){ return a.created-b.created; }); });
    if (r[4] && r[4].v){ Object.assign(S, r[4].v); }
    if (!S.otherList && S.lists.length) S.otherList = S.lists[0].id;
  }).then(function(){ return DB.all('kv'); }).then(function(rows){ rows.forEach(function(r){ if (r.k==='stations') S.stations=r.v||{}; if (r.k.indexOf('ov-')===0) S.ov[r.v.id]=r.v; }); })
  .then(function(){ return Promise.all(S.lists.filter(function(l){ return l.kind==='tabelog'; }).map(function(l){ return loadTabelogList(l.slug).catch(function(){}); })); });
}
function saveUI(){ DB.put('kv', {k:'ui', v:{tab:S.tab, otherList:S.otherList, sort:S.sort, vis:S.vis}}).catch(function(){}); }

/* ---------- scoring ---------- */
var AXES = [['amb','お店の雰囲気'],['drink','飲み物'],['food','食事']];
function score(r){
  if (!r) return null;
  var vals = AXES.map(function(a){ return r[a[0]]||0; }).filter(function(v){ return v>0; });
  if (!vals.length) return {n:0, total:null, avg:null, filled:null};
  var avg = vals.reduce(function(a,b){ return a+b; },0)/vals.length;
  var total = Math.round((vals.reduce(function(a,b){ return a+b; },0) + avg*(3-vals.length))*10)/10;
  return {n:vals.length, total:total, avg:avg, filled: vals.length<3 ? Math.round(avg*10)/10 : null};
}
function fmtTotal(t){ return t==null ? '–' : (Number.isInteger(t) ? String(t) : t.toFixed(1)); }

/* ---------- stores ---------- */
function stores(){
  if (S.tab==='kissa2026') return KISSA;
  if (S.tab==='other'){ var l=listById(S.otherList); var base = (l&&l.kind==='tabelog') ? (S.tl[l.slug]||[]) : []; return base.concat(S.custom.filter(function(s){ return s.list===S.otherList; })); }
  return S.custom.filter(function(s){ return s.list==='free'; });
}
function listById(id){ return S.lists.filter(function(x){ return x.id===id; })[0]; }
function allStores(){ var a=KISSA.concat(S.custom); Object.keys(S.tl).forEach(function(k){ a=a.concat(S.tl[k]); }); return a; }

/* ---------- 食べログ百名店リスト（data/lists/*.json） ---------- */
function loadIndex(){
  if (S.tlIndex) return Promise.resolve(S.tlIndex);
  return fetch('data/lists/index.json').then(function(r){ return r.json(); }).then(function(j){ S.tlIndex=j; return DB.put('kv',{k:'tl-index',v:j}).then(function(){ return j; }); })
    .catch(function(){ return DB.get('kv','tl-index').then(function(r){ S.tlIndex=r?r.v:[]; return S.tlIndex; }); });
}
function loadTabelogList(slug){
  if (S.tl[slug]) return Promise.resolve(S.tl[slug]);
  var parse=function(j){
    var stores=(j.stores||[]).map(function(x){ var rid=x.path.split('/').pop(); var st=stationFor(x.pref,x.area);
      var o={id:'tl-'+slug+'-'+rid, name:x.name, pref:x.pref, area:x.area, closed:x.closed||'', isNew:!!x.isNew, tabelog:'https://tabelog.com/'+x.path+'/', lat:st?st[0]:null, lng:st?st[1]:null, approx:true, list:'tl:'+slug};
      if (S.ov[o.id]) Object.assign(o, S.ov[o.id]); return o; });
    S.tl[slug]=stores; if (window.OSM && window.OSM.pos) applyPositions(window.OSM.pos); queueGeocode(stores); return stores; };
  return fetch('data/lists/'+slug+'.json').then(function(r){ if(!r.ok) throw new Error('no list'); return r.json(); }).then(function(j){ DB.put('kv',{k:'tl-'+slug,v:j}).catch(function(){}); return parse(j); })
    .catch(function(){ return DB.get('kv','tl-'+slug).then(function(r){ if(!r) throw new Error('リストを読み込めません（オフライン？）'); return parse(r.v); }); });
}
function stationFor(pref, area){ if(!area) return null; var k=pref+'|'+area; if (window.OSM && OSM.st && OSM.st[k]) return OSM.st[k]; if (S.stations[k]) return S.stations[k]; if (window.STATIONS[area]) return window.STATIONS[area]; return null; }
// 駅名から座標を少しずつ調べる（Nominatim、1件ずつ間隔をあけて）
function queueGeocode(stores){
  var seen={}; stores.forEach(function(s){ if (s.lat!=null||!s.area) return; var k=s.pref+'|'+s.area; if (seen[k]||S.stations[k]===null) return; seen[k]=1; if (S.geoQueue.indexOf(k)<0) S.geoQueue.push(k); });
  runGeocode();
}
var geoRerenderT=null;
function runGeocode(){
  if (S.geoBusy || !S.geoQueue.length || !navigator.onLine) return;
  S.geoBusy=true; var k=S.geoQueue.shift(), pref=k.split('|')[0], area=k.split('|')[1];
  var q = /駅$/.test(area) ? area+' '+pref : area+' '+pref;
  forwardGeocode(q).then(function(g){ S.stations[k]= g ? [g.lat,g.lng] : null; })
    .catch(function(){ S.geoFail=S.geoFail||{}; S.geoFail[k]=(S.geoFail[k]||0)+1; if (S.geoFail[k]<2) S.geoQueue.push(k); else if (Object.keys(S.geoFail).length>3) S.geoQueue=[]; })
    .then(function(){
      if (S.stations[k]){ allStores().forEach(function(s){ if (s.lat==null && s.pref+'|'+s.area===k){ s.lat=S.stations[k][0]; s.lng=S.stations[k][1]; } });
        clearTimeout(geoRerenderT); geoRerenderT=setTimeout(function(){
          if (!$('#sheetWrap').hidden || S.rating || S.detail) return;
          if (S.view==='map' && S.drawPins){ S.drawPins(); return; }
          var a=document.activeElement; if (a && /INPUT|TEXTAREA/.test(a.tagName)) return;
          if (S.view==='list' && S.sort==='dist') drawResults();
        }, 1500); }
      DB.put('kv',{k:'stations',v:S.stations}).catch(function(){});
      setTimeout(function(){ S.geoBusy=false; runGeocode(); }, 1200);
    });
}
function findStore(id){ return allStores().filter(function(s){ return s.id===id; })[0]; }
function listName(id){ if (id==='kissa2026') return '喫茶 百名店 2026'; if (id==='free') return 'その他のお店'; var l=S.lists.filter(function(x){ return x.id===id; })[0]; return l?l.name:''; }
function dist(a,b){ if(!a||!b||a.lat==null||b.lat==null) return null; var R=6371,dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180,x=Math.sin(dLat/2),y=Math.sin(dLng/2);
  var h=x*x+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*y*y; return 2*R*Math.asin(Math.sqrt(h)); }
function fmtDist(km){ if (km==null) return ''; if (km<1) return Math.round(km*1000)+' m'; if (km<10) return km.toFixed(1)+' km'; return Math.round(km)+' km'; }
function walkMin(km){ return Math.max(1, Math.round(km/0.08)); }

function visible(){
  var a = stores(), R = S.ratings;
  if (S.pref) a = a.filter(function(s){ return s.pref===S.pref; });
  if (S.vis==='visited') a = a.filter(function(s){ return R[s.id]; });
  if (S.vis==='unvisited') a = a.filter(function(s){ return !R[s.id]; });
  if (S.q){ var q=S.q.toLowerCase(); a = a.filter(function(s){ return (s.name+(s.area||'')+(s.pref||'')+(s.address||'')).toLowerCase().indexOf(q)>=0; }); }
  var k = S.sort, tot = function(s){ var sc=score(R[s.id]); return sc&&sc.total!=null?sc.total:-1; };
  var byName = function(x,y){ return x.name.localeCompare(y.name,'ja'); };
  return a.slice().sort(function(x,y){
    var rx=R[x.id], ry=R[y.id];
    if (k==='name') return byName(x,y);
    if (k==='pref') return prefIdx(x.pref)-prefIdx(y.pref) || String(x.area).localeCompare(String(y.area),'ja') || byName(x,y);
    if (k==='date') return ((ry&&ry.date)||'').localeCompare((rx&&rx.date)||'') || byName(x,y);
    if (k==='dist'){ var dx=dist(S.pos,x), dy=dist(S.pos,y); if(dx==null&&dy==null) return byName(x,y); if(dx==null) return 1; if(dy==null) return -1; return dx-dy; }
    if (k==='friends'){ var fx=friendSum(x.id), fy=friendSum(y.id); return ((fy&&fy.total)||-1)-((fx&&fx.total)||-1) || tot(y)-tot(x) || byName(x,y); }
    if (k==='total') return tot(y)-tot(x) || prefIdx(x.pref)-prefIdx(y.pref) || String(x.area).localeCompare(String(y.area),'ja') || byName(x,y);
    var vx = rx ? (rx[k]||0) : -1, vy = ry ? (ry[k]||0) : -1;
    return vy-vx || tot(y)-tot(x) || byName(x,y);
  });
}

/* ---------- photos ---------- */
var urlCache = {};
function photoURL(p){ if (!urlCache[p.id]) urlCache[p.id] = URL.createObjectURL(p.blob); return urlCache[p.id]; }
function coverURL(storeId){ var ps=S.photoIdx[storeId]; return ps&&ps.length ? photoURL(ps[0]) : null; }
function compress(file, max){
  return new Promise(function(res){
    var img = new Image(), u = URL.createObjectURL(file);
    img.onload = function(){
      var w=img.naturalWidth,h=img.naturalHeight,s=Math.min(1, max/Math.max(w,h));
      var c=document.createElement('canvas'); c.width=Math.round(w*s); c.height=Math.round(h*s);
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      c.toBlob(function(b){ URL.revokeObjectURL(u); res(b||file); }, 'image/jpeg', 0.84);
    };
    img.onerror = function(){ URL.revokeObjectURL(u); res(file); };
    img.src = u;
  });
}
// EXIF GPS（JPEGのみ）。撮った場所から住所を補完するために使う
function exifGPS(file){
  return new Promise(function(res){
    var fr = new FileReader();
    fr.onload = function(){
      try{
        var v = new DataView(fr.result); if (v.getUint16(0)!==0xFFD8) return res(null);
        var off=2, len=v.byteLength;
        while (off<len){ if (v.getUint16(off)!==0xFFE1){ if ((v.getUint16(off)&0xFF00)!==0xFF00) break; off += 2+v.getUint16(off+2); continue; }
          var tiff = off+10; var le = v.getUint16(tiff)===0x4949; var g=function(o,sz){ return sz===2?v.getUint16(o,le):v.getUint32(o,le); };
          var ifd0 = tiff+g(tiff+4,4), n=g(ifd0,2), gpsOff=0;
          for (var i=0;i<n;i++){ var e=ifd0+2+i*12; if (g(e,2)===0x8825){ gpsOff=tiff+g(e+8,4); } }
          if (!gpsOff) return res(null);
          var m=g(gpsOff,2), d={};
          for (var j=0;j<m;j++){ var e2=gpsOff+2+j*12, tag=g(e2,2), type=g(e2+2,2), cnt=g(e2+4,4), vo=e2+8;
            if (type===2){ d[tag]=String.fromCharCode(v.getUint8(cnt>4?tiff+g(vo,4):vo)); }
            else if (type===5){ var p=tiff+g(vo,4), arr=[]; for (var k=0;k<cnt;k++){ arr.push(g(p+k*8,4)/g(p+k*8+4,4)); } d[tag]=arr; } }
          if (!d[2]||!d[4]) return res(null);
          var lat=d[2][0]+d[2][1]/60+d[2][2]/3600, lng=d[4][0]+d[4][1]/60+d[4][2]/3600;
          if (d[1]==='S') lat=-lat; if (d[3]==='W') lng=-lng;
          return res({lat:lat,lng:lng});
        }
        res(null);
      }catch(e){ res(null); }
    };
    fr.onerror=function(){ res(null); };
    fr.readAsArrayBuffer(file.slice(0, 256*1024));
  });
}
function addPhotos(storeId, files){
  var list = Array.prototype.slice.call(files||[]);
  if (!list.length) return Promise.resolve([]);
  return Promise.all(list.map(function(f){ return compress(f, 1600).then(function(b){ var p={id:uid('ph'), storeId:storeId, blob:b, created:Date.now()}; return DB.put('photos',p).then(function(){ return p; }); }); }))
    .then(function(ps){ S.photoIdx[storeId]=(S.photoIdx[storeId]||[]).concat(ps); return ps; });
}

/* ---------- geocode (Nominatim / OpenStreetMap) ---------- */
function reverseGeocode(lat,lng){
  return fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ja&lat='+lat+'&lon='+lng,{headers:{'Accept':'application/json'}}).then(function(r){ return r.json(); }).then(function(j){
    var a=j.address||{}; var pref=a.province||a.state||''; var city=a.city||a.town||a.village||a.county||''; var ward=a.city_district||a.suburb||a.quarter||a.neighbourhood||'';
    var block=[a.road,a.house_number].filter(Boolean).join('');
    return {pref:pref, address:[pref,city,ward,block].filter(Boolean).join(''), display:j.display_name||''};
  });
}
function forwardGeocode(q){
  return fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=ja&countrycodes=jp&limit=1&q='+encodeURIComponent(q),{headers:{'Accept':'application/json'}}).then(function(r){ return r.json(); }).then(function(j){ return j&&j[0] ? {lat:+j[0].lat,lng:+j[0].lon,display:j[0].display_name} : null; });
}
function locate(){
  return new Promise(function(res){
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(function(p){ S.pos={lat:p.coords.latitude,lng:p.coords.longitude}; res(S.pos); }, function(){ res(null); }, {enableHighAccuracy:true, timeout:8000, maximumAge:60000});
  });
}

/* ---------- render: header + list ---------- */
function render(){
  $$('#nav button').forEach(function(b){ b.classList.toggle('on', b.dataset.view===S.view); });
  var main=$('#main'), onMap = S.view==='map' && !S.detail && !S.rating; main.className='main'+(onMap?' map':'');
  $('#hdr').hidden = onMap;
  if (!onMap && S.map){ try{ S.map.remove(); }catch(e){} S.map=null; S.drawPins=null; }
  document.body.classList.toggle('rating', !!S.rating);
  if (S.rating) return renderRate();
  if (S.detail) return renderDetail();
  if (S.view==='list') renderList();
  else if (S.view==='map') renderMap();
  else if (S.view==='stats') renderStats();
  else if (S.view==='settings') renderSettings();
}
function tabsHTML(){
  return '<div class="tabs">'+
    [['kissa2026','喫茶'],['other','他の百名店'],['free','その他']].map(function(t){ return '<button data-tab="'+t[0]+'" class="'+(S.tab===t[0]?'on':'')+'">'+t[1]+'</button>'; }).join('')+
    (S.view==='list' ? '<div class="right"><select id="sortSel" aria-label="並べ替え">'+
      [['total','合計順'],['friends','みんなの評価順'],['amb','雰囲気順'],['drink','飲み物順'],['food','食事順'],['date','訪問日順'],['dist','近い順'],['pref','エリア順'],['name','店名順']].map(function(o){ return '<option value="'+o[0]+'"'+(S.sort===o[0]?' selected':'')+'>'+o[1]+' ▾</option>'; }).join('')+'</select></div>' : '')+
  '</div>';
}
function headerHTML(){
  var all=stores(), done=all.filter(function(s){ return S.ratings[s.id]; });
  var title = S.tab==='other' ? (S.otherList ? esc(listName(S.otherList)) : '他の百名店') : S.tab==='free' ? 'その他のお店' : '';
  var count = done.length+'<small> / '+(S.tab==='kissa2026'?100:all.length)+' 軒</small>';
  var eyebrow = S.tab==='kissa2026' ? '喫茶 百名店 2026' : S.tab==='other' ? '他の百名店' : 'その他のお店';
  return '<div class="hdr-top"><div><div class="eyebrow">'+eyebrow+'</div><h1'+(title&&title.length>9?' style="font-size:22px"':'')+'>'+(S.tab==='kissa2026'?count:(title||'')+' <small style="font-size:16px">'+(S.tab==='other'&&listById(S.otherList)&&listById(S.otherList).kind==='tabelog'?done.length+' / '+all.length:done.length)+' 軒</small>')+'</h1></div>'+
    '<div style="display:flex;gap:6px"><button class="iconbtn" id="addBtn" aria-label="お店を追加"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button></div></div>'+ tabsHTML();
}
function renderList(){
  var hdr=$('#hdr'), main=$('#main');
  var cl=S.tab==='other'?listById(S.otherList):null;
  if (cl && cl.kind==='tabelog' && !S.tl[cl.slug]){ hdr.innerHTML=headerHTML(); main.innerHTML='<div class="empty">読み込み中…</div>'; bindHeader(); loadTabelogList(cl.slug).then(function(){ if (S.view==='list'&&!S.detail) renderList(); }).catch(function(e){ main.innerHTML='<div class="empty"><b>'+esc(cl.name)+'</b>'+esc(e.message)+'</div>'; }); return; }
  hdr.innerHTML = headerHTML();
  if (S.tab==='other' && !S.lists.length){
    main.innerHTML = '<div class="empty"><b>百名店のリストがまだありません</b>食べログのジャンルを選ぶと100店が入ります</div><button class="btn" id="newListBtn">＋ 百名店のリストを追加</button>'+genreChips();
    bindHeader(); $('#newListBtn').onclick=function(){ openNewList(); }; $$('[data-genre]').forEach(function(b){ b.onclick=function(){ openNewList(b.dataset.genre); }; }); return;
  }
  var prefs = {}; stores().forEach(function(s){ prefs[s.pref]=(prefs[s.pref]||0)+1; });
  var prefList = Object.keys(prefs).sort(function(a,b){ return prefIdx(a)-prefIdx(b); });
  if (S.pref && !prefs[S.pref]) S.pref='';
  var html = '<div class="chips">'+
    [['all','すべて'],['visited','行った'],['unvisited','未訪問']].map(function(v){ return '<button class="chip'+(S.vis===v[0]?' on':'')+'" data-vis="'+v[0]+'">'+v[1]+'</button>'; }).join('')+
    (S.tab==='other' ? '<button class="chip" id="listPick">'+esc(listName(S.otherList)||'リストを選ぶ')+' ▾</button>' : '')+
    prefList.map(function(p){ return '<button class="chip'+(S.pref===p?' on':'')+'" data-pref="'+esc(p)+'">'+esc(p)+' '+prefs[p]+'</button>'; }).join('')+
  '</div>'+
  '<div class="search" style="margin-top:10px"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" type="search" placeholder="店名・駅名で検索" value="'+esc(S.q)+'" autocomplete="off"></div>';
  if (S.sort==='dist' && !S.pos){ locate().then(function(p){ if (p) render(); else toast('位置情報が使えないので店名順に並べています'); }); }
  main.innerHTML = html+'<div id="results">'+resultsHTML()+'</div>';
  bindHeader();
  var q=$('#q'), composing=false;
  q.addEventListener('compositionstart', function(){ composing=true; });
  q.addEventListener('compositionend', function(){ composing=false; S.q=q.value.trim(); drawResults(); });
  q.addEventListener('input', function(e){ if (composing || e.isComposing) return; S.q=q.value.trim(); drawResults(); });
  $$('[data-vis]').forEach(function(b){ b.onclick=function(){ S.vis=b.dataset.vis; saveUI(); renderList(); }; });
  $$('[data-pref]').forEach(function(b){ b.onclick=function(){ S.pref = S.pref===b.dataset.pref?'':b.dataset.pref; renderList(); }; });
  var lp=$('#listPick'); if (lp) lp.onclick=openListPicker;
  bindResults();
}
function drawResults(){ var r=$('#results'); if (!r) return; r.innerHTML=resultsHTML(); bindResults(); }
function bindResults(){ $$('#results [data-open]').forEach(function(b){ b.onclick=function(){ openDetail(b.dataset.open); }; }); }
function resultsHTML(){
  var html='', v = visible(), vis = v.filter(function(s){ return S.ratings[s.id]; }), unv = v.filter(function(s){ return !S.ratings[s.id]; });
  if (!v.length) html += '<div class="empty"><b>'+(stores().length?'該当するお店がありません':'まだお店がありません')+'</b>'+(stores().length?'絞り込みを変えてみてください':'右上の＋から登録できます')+'</div>';
  else {
    if (vis.length) html += '<div class="sec" style="margin-top:14px">行った '+vis.length+' 軒</div><div class="cards">'+vis.map(cardHTML).join('')+'</div>';
    if (unv.length && S.vis!=='visited'){
      html += '<div class="sec">'+(S.sort==='dist'&&S.pos?'近い未訪問':'未訪問')+' '+unv.length+' 軒</div><div class="cards">'+unv.slice(0, 120).map(unvHTML).join('')+(unv.length>120?'<div class="empty" style="padding:16px">他 '+(unv.length-120)+' 軒は検索か絞り込みで</div>':'')+'</div>';
    }
  }
  return html;
}
function bindHeader(){
  $$('[data-tab]').forEach(function(b){ b.onclick=function(){ S.tab=b.dataset.tab; S.pref=''; S.q=''; saveUI(); render(); }; });
  var ss=$('#sortSel'); if (ss) ss.onchange=function(){ S.sort=ss.value; saveUI(); renderList(); };
  var ab=$('#addBtn'); if (ab) ab.onclick=function(){ if (S.tab==='kissa2026') openNewStore('free'); else if (S.tab==='other') openNewStore(S.otherList||''); else openNewStore('free'); };
}
function cardHTML(s){
  var r=S.ratings[s.id], sc=score(r), cu=coverURL(s.id);
  return '<button class="card" data-open="'+s.id+'">'+(cu?'<img src="'+cu+'" alt="">':'<div class="ph">写真なし</div>')+'<div class="shade"></div>'+
    '<div class="top"><span class="pill">'+esc(s.area||s.pref||'')+'</span>'+(r.date?'<span class="pill dim">'+shortDate(r.date)+'</span>':'')+(s.isNew?'<span class="pill new">初選出</span>':'')+(function(){ var f=friendSum(s.id); return f?'<span class="pill fr">みんな '+fmtAvg(f.total)+' · '+f.n+'人</span>':''; })()+'</div>'+
    '<div class="bot"><div><div class="nm">'+esc(s.name)+'</div><div class="ax">'+AXES.map(function(a){ return '<span>'+a[1].replace('お店の','')+' '+(r[a[0]]>0?r[a[0]]:'–')+'</span>'; }).join('')+'</div></div>'+
    '<div class="sc">'+fmtTotal(sc.total)+'<small>/ 30'+(sc.filled!=null?' 補完':'')+'</small></div></div></button>';
}
function unvHTML(s){
  var d = S.pos ? dist(S.pos,s) : null, f = friendSum(s.id);
  return '<button class="card unv" data-open="'+s.id+'"><div><div class="nm">'+esc(s.name)+'</div><div class="sub">'+esc(s.pref)+' · '+esc(s.area||'')+(s.closed?' · 定休 '+esc(s.closed):'')+(s.isNew?' · 初選出':'')+'</div>'+(f?'<div class="frline">'+esc(f.entries.slice(0,3).map(function(e){ return e.name; }).join('、'))+(f.n>3?' ほか':'')+' が行った</div>':'')+'</div><div class="dist">'+(f?'<span class="frb">'+fmtAvg(f.total)+'</span>':'')+(d!=null?'<span>'+fmtDist(d)+'</span>':'')+'</div></button>';
}
function genreChips(){
  return '<p style="font-size:12px;color:var(--muted);line-height:1.7;margin-top:14px">食べログの百名店（焼肉・ラーメン・寿司など全ジャンル、地域版も）を選ぶと、その100店がそのまま入ります。百名店以外のリストも自由に作れます。</p>';
}

/* ---------- detail ---------- */
function openDetail(id){ S.detail=id; window.scrollTo(0,0); render(); }
function closeDetail(){ S.detail=null; render(); }
function renderDetail(){
  var s=findStore(S.detail); if (!s){ S.detail=null; return render(); }
  var r=S.ratings[s.id]||null, sc=score(r), ps=S.photoIdx[s.id]||[];
  $('#hdr').innerHTML='';
  var ringHTML = AXES.map(function(a){ var v=r?r[a[0]]||0:0; var deg=v*36;
    return '<div class="ring"><div class="r'+(v?'':' none')+'" style="background:conic-gradient(var(--amber) '+deg+'deg, var(--line2) 0)"><div>'+(v||'未')+'</div></div><div class="l">'+a[1].replace('お店の','')+'</div></div>'; }).join('');
  var addr = s.address || '';
  var mapq = encodeURIComponent((s.name)+' '+(addr||s.area||''));
  var gmaps = s.lat!=null && !s.approx ? 'https://www.google.com/maps/search/?api=1&query='+s.lat+','+s.lng : 'https://www.google.com/maps/search/?api=1&query='+mapq;
  $('#main').innerHTML =
    '<div class="hero"><div class="strip" id="strip">'+(ps.length?ps.map(function(p){ return '<img src="'+photoURL(p)+'" alt="">'; }).join(''):'<div class="ph">まだ写真がありません</div>')+'</div><div class="shade"></div>'+
    '<button class="back" id="back" aria-label="戻る">‹</button>'+(ps.length>1?'<div class="cnt" id="cnt">1 / '+ps.length+'</div>':'')+
    '<div class="ttl"><div style="min-width:0"><div class="eyebrow">'+esc(listName(s.list))+(s.isNew?' · 初選出':'')+'</div><h2>'+esc(s.name)+'</h2><div class="sub">'+esc([s.area, r&&r.date?fmtDate(r.date):''].filter(Boolean).join(' · '))+'</div></div>'+
    (r?'<div class="big">'+fmtTotal(sc.total)+'<small>/ 30'+(sc.filled!=null?' 補完':'')+'</small></div>':'')+'</div></div>'+
    '<div class="rings">'+ringHTML+'</div>'+
    (sc&&sc.filled!=null?'<p style="font-size:11px;color:var(--muted);margin:8px 2px 0">未評価の軸は評価済みの平均 '+sc.filled+' で補って30点換算しています</p>':'')+
    (r&&(r.orders&&r.orders.length||r.order)?'<div class="sec">頼んだもの</div><div class="orders">'+((r.orders&&r.orders.length?r.orders:r.order.split(/[、,，]+/)).map(function(o){ return '<span class="chip">'+esc(o.trim())+'</span>'; }).join(''))+'</div>':'')+
    (r&&r.memo?'<div class="sec">メモ</div><p class="memo">'+esc(r.memo)+'</p>':'')+
    friendsHTML(s)+
    '<div class="grid2" style="margin-top:18px"><a class="mapmini" href="'+gmaps+'" target="_blank" rel="noopener"><span class="pin"></span>'+esc(addr||(s.pref+' '+(s.area||'')))+(s.approx&&!addr?'（駅周辺）':'')+' · Googleマップで開く ↗</a>'+
    '<div class="kv">'+(s.closed?'<div><span>定休日</span><b>'+esc(s.closed)+'</b></div>':'')+'<div><span>エリア</span><b>'+esc(s.pref+(s.area?' '+s.area:''))+'</b></div>'+(s.tabelog?'<div><span>食べログ</span><b><a href="'+esc(s.tabelog)+'" target="_blank" rel="noopener">開く ↗</a></b></div>':'')+'</div></div>'+
    (ps.length?'<div class="sec">写真 '+ps.length+'</div><div class="thumbs">'+ps.map(function(p){ return '<div class="del"><img src="'+photoURL(p)+'" alt=""><button data-delph="'+p.id+'" aria-label="この写真を削除">×</button></div>'; }).join('')+'</div>':'')+
    '<div class="acts"><button class="btn ghost sm" id="addPh" style="width:50px;padding:0;border-radius:50%;height:50px" aria-label="写真を追加"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></button>'+
    '<button class="btn" id="rate">'+(r?'評価を編集':'評価を記録する')+'</button></div>'+
    '<div class="acts" style="margin-top:10px"><button class="btn ghost sm" id="editStore">店の情報を編集</button>'+(r?'<button class="btn danger sm" id="unvisit">未訪問に戻す</button>':'')+'</div>';
  $('#back').onclick=closeDetail;
  $('#rate').onclick=function(){ openRate(s.id); };
  $('#addPh').onclick=function(){ pickPhotos(function(files){ addPhotos(s.id,files).then(function(){ toast('写真を追加しました'); render(); }); }); };
  $('#editStore').onclick=function(){ openEditStore(s); };
  var uv=$('#unvisit'); if (uv) uv.onclick=function(){ confirmSheet('評価を消して未訪問に戻しますか？','写真は残ります。', function(){ DB.del('ratings',s.id).then(function(){ delete S.ratings[s.id]; render(); toast('未訪問に戻しました'); }); }); };
  $$('[data-delph]').forEach(function(b){ b.onclick=function(){ confirmSheet('この写真を削除しますか？','', function(){ DB.del('photos',b.dataset.delph).then(function(){ S.photoIdx[s.id]=(S.photoIdx[s.id]||[]).filter(function(p){ return p.id!==b.dataset.delph; }); render(); }); }); }; });
  var strip=$('#strip'), cnt=$('#cnt'); if (cnt) strip.onscroll=function(){ cnt.textContent=(Math.round(strip.scrollLeft/strip.clientWidth)+1)+' / '+ps.length; };
}

function friendsHTML(s){
  var c=CL(); if (!c.configured) return '';
  if (!c.user) return '<p class="note" style="margin-top:16px">設定でログインすると、グループの友だちや家族の評価もここに出ます。</p>';
  var f=c.summary(s.id);
  if (!f) return (c.profile&&(c.profile.groups||[]).length) ? '<div class="sec">みんなの評価</div><p class="note">グループのメンバーはまだ記録していません</p>' : '';
  return '<div class="sec">みんなの評価 · '+f.n+'人</div>'+
    '<div class="fr-sum"><div class="fr-big">'+fmtAvg(f.total)+'<small>/ 30 平均</small></div><div class="bars">'+AXES.map(function(a){ var v=f[a[0]]; return '<div><span>'+a[1].replace('お店の','')+'</span><i style="width:'+((v||0)*10)+'%"></i><b>'+fmtAvg(v)+'</b></div>'; }).join('')+'</div></div>'+
    f.entries.map(function(e){
      return '<div class="fr-e"><div class="fr-h"><b>'+esc(e.name)+'</b><span>'+esc(e.date?fmtDate(e.date):'')+'</span><span class="fr-t">'+fmtTotal(e.total)+'</span></div>'+
        '<div class="fr-ax">'+AXES.map(function(a){ return a[1].replace('お店の','')+' '+(e[a[0]]>0?e[a[0]]:'–'); }).join(' · ')+'</div>'+
        ((e.orders&&e.orders.length)?'<div class="orders" style="margin:6px 0 0">'+e.orders.map(function(o){ return '<span class="chip">'+esc(o)+'</span>'; }).join('')+'</div>':'')+
        (e.memo?'<p class="memo" style="margin-top:6px">'+esc(e.memo)+'</p>':'')+'</div>';
    }).join('');
}
// 友だちの記録から店を開く（自分のリストに無い店でも開けるように）
function openShared(storeId){
  var s=findStore(storeId); if (s) return openDetail(storeId);
  var es=(CL().shared||{})[storeId]||[], e=es[0]; if (!e) return;
  if (e.list && e.list.indexOf('tl:')===0){ return loadTabelogList(e.list.slice(3)).then(function(){ if (findStore(storeId)) openDetail(storeId); }).catch(function(){ toast('リストを読み込めません'); }); }
  openSheet('<div class="eyebrow">'+esc(e.listName||'友だちの記録')+'</div><h2>'+esc(e.storeName)+'</h2><div class="meta">'+esc([e.pref,e.area,e.address].filter(Boolean).join(' · '))+'</div>'+
    '<p class="note">'+esc(es.map(function(x){ return x.name; }).join('、'))+' が記録したお店です。自分の「その他のお店」に入れると、評価を付けたり、みんなの評価を見たりできます。</p>'+
    '<div class="acts"><button class="btn ghost sm" id="cancel">閉じる</button><button class="btn" id="adopt">自分のリストに入れる</button></div>');
  $('#cancel').onclick=closeSheet;
  $('#adopt').onclick=function(){ var ns={id:storeId, name:e.storeName, pref:e.pref||'未設定', area:e.area||'', address:e.address||'', lat:e.lat, lng:e.lng, approx:!!e.approx, tabelog:e.tabelog||'', closed:'', list:'free'};
    DB.put('stores',ns).then(function(){ S.custom.push(ns); closeSheet(); openDetail(storeId); }); };
}

/* ---------- sheets ---------- */
function openSheet(html){ $('#sheet').innerHTML='<div class="grip"></div>'+html; $('#sheetWrap').hidden=false; document.body.style.overflow='hidden'; }
function closeSheet(){ $('#sheetWrap').hidden=true; document.body.style.overflow=''; }
function confirmSheet(title, body, onYes){
  openSheet('<h2 style="font-size:20px">'+esc(title)+'</h2><div class="meta">'+esc(body)+'</div><div class="acts"><button class="btn ghost" id="no">やめる</button><button class="btn" id="yes">はい</button></div>');
  $('#no').onclick=closeSheet; $('#yes').onclick=function(){ closeSheet(); onYes(); };
}
var toastT; function toast(m){ var t=$('#toast'); t.textContent=m; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(function(){ t.classList.remove('show'); },2000); }
function pickPhotos(cb){ var inp=$('#photoInput'); inp.value=''; inp.onchange=function(){ if (inp.files.length) cb(inp.files); }; inp.click(); }

function openRate(storeId){ closeSheet(); S.rating=storeId; window.scrollTo(0,0); render(); }
function closeRate(){ S.rating=null; window.scrollTo(0,0); render(); }
function renderRate(){
  var storeId=S.rating, s=findStore(storeId); if(!s){ S.rating=null; return render(); }
  var r=Object.assign({storeId:storeId, amb:0, drink:0, food:0, memo:'', order:'', date:todayStr()}, S.ratings[storeId]||{});
  var cur={amb:r.amb,drink:r.drink,food:r.food}, ps=S.photoIdx[storeId]||[], cu=coverURL(storeId);
  var orders = Array.isArray(r.orders) ? r.orders.slice() : (r.order ? r.order.split(/[、,，\n]+/).map(function(x){ return x.trim(); }).filter(Boolean) : []);
  var orders0 = orders.join('、');
  $('#hdr').innerHTML='';
  var axisHTML=function(k,l,h){ return '<div class="axis"><div class="lab"><span>'+l+'<small>'+h+'</small></span><output id="o-'+k+'" class="'+(cur[k]?'':'none')+'">'+(cur[k]||'未評価')+'</output></div><div class="scale" data-k="'+k+'">'+Array.apply(null,Array(10)).map(function(_,i){ var n=i+1; return '<button type="button" data-n="'+n+'" class="'+(cur[k]>=n?'on':'')+(cur[k]===n?' cur':'')+'">'+n+'</button>'; }).join('')+'</div></div>'; };
  $('#main').innerHTML=
    '<nav class="rail" aria-label="移動"><button id="rCancel" aria-label="評価をやめて戻る"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>'+
    '<button data-rv="list" aria-label="リスト"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg></button>'+
    '<button data-rv="map" aria-label="地図"><svg viewBox="0 0 24 24"><path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10Z"/><circle cx="12" cy="11" r="2"/></svg></button>'+
    '<button data-rv="stats" aria-label="統計"><svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></button>'+
    '<button id="rPhoto" aria-label="写真を追加"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>'+(ps.length?'<i>'+ps.length+'</i>':'')+'</button></nav>'+
    '<div class="rate-wrap">'+
    '<div class="rate-hero">'+(cu?'<img src="'+cu+'" alt="">':'<div class="ph">写真なし</div>')+'<div class="shade"></div><div class="ttl"><div class="eyebrow">評価を記録</div><h2>'+esc(s.name)+'</h2><div class="sub">'+esc(s.pref+' · '+(s.area||''))+'</div></div></div>'+
    axisHTML('amb','お店の雰囲気','内装・音・居心地')+axisHTML('drink','飲み物','コーヒー・紅茶・ジュース')+axisHTML('food','食事','頼まなければ空のまま')+
    '<div class="sumbox"><div><div class="t">合計（30点換算）</div><div class="n" id="sumNote"></div></div><div class="v" id="sum"></div></div>'+
    '<div class="f"><label for="f-date">訪問日</label><input type="date" id="f-date" value="'+esc(r.date)+'"></div>'+
    '<div class="f"><label for="f-order">頼んだもの <small style="color:var(--muted);letter-spacing:0">1品ずつ追加。タップで削除</small></label><div class="orders" id="orders"></div><div class="orderrow"><input type="text" id="f-order" placeholder="例：ナポリタン" enterkeyhint="done" autocomplete="off"><button type="button" class="btn sm" id="addOrder">追加</button></div></div>'+
    '<div class="f"><label for="f-memo">メモ</label><textarea id="f-memo" rows="3" placeholder="席の雰囲気、また来たいか、待ち時間…">'+esc(r.memo)+'</textarea></div>'+
    '<div class="acts"><button class="btn ghost sm" id="cancel">やめる</button><button class="btn" id="save">保存する</button></div></div>';
  function upd(){ var sc=score(cur); $('#sum').innerHTML=(sc.total==null?'–':fmtTotal(sc.total))+'<small> / 30</small>'; $('#sumNote').textContent = sc.n===0?'点数を1つ以上入れてください': sc.n<3?'未評価の軸は平均 '+sc.filled+' で補完':''; }
  upd();
  function drawOrders(){ $('#orders').innerHTML = orders.map(function(o,i){ return '<button type="button" class="chip on" data-oi="'+i+'">'+esc(o)+' ×</button>'; }).join('') || '<span style="font-size:12px;color:var(--dim)">まだありません</span>'; $$('[data-oi]').forEach(function(b){ b.onclick=function(){ orders.splice(+b.dataset.oi,1); drawOrders(); }; }); }
  function addOrder(){ var inp=$('#f-order'), v=inp.value.trim(); if(!v) return; v.split(/[、,，]+/).forEach(function(x){ x=x.trim(); if(x && orders.indexOf(x)<0) orders.push(x); }); inp.value=''; drawOrders(); inp.focus(); }
  drawOrders(); $('#addOrder').onclick=addOrder; $('#f-order').onkeydown=function(e){ if (e.isComposing || e.keyCode===229) return; if(e.key==='Enter'){ e.preventDefault(); addOrder(); } };
  $$('.scale').forEach(function(scl){ scl.onclick=function(e){ var b=e.target.closest('button'); if(!b) return; var k=scl.dataset.k,n=+b.dataset.n; cur[k]=cur[k]===n?0:n;
    $$('button',scl).forEach(function(x){ var m=+x.dataset.n; x.className=(cur[k]>=m?'on':'')+(cur[k]===m?' cur':''); }); var o=$('#o-'+k); o.textContent=cur[k]||'未評価'; o.className=cur[k]?'':'none'; upd(); }; });
  var leave=function(then){ var dirty = cur.amb!==r.amb||cur.drink!==r.drink||cur.food!==r.food||$('#f-memo').value.trim()!==r.memo||orders.join('、')!==orders0||$('#f-order').value.trim();
    if (!dirty) return then(); confirmSheet('入力した評価を保存せずに移動しますか？','', then); };
  $('#rCancel').onclick=$('#cancel').onclick=function(){ leave(closeRate); };
  $$('[data-rv]').forEach(function(b){ b.onclick=function(){ leave(function(){ S.rating=null; S.detail=null; S.view=b.dataset.rv; window.scrollTo(0,0); render(); }); }; });
  $('#rPhoto').onclick=function(){ pickPhotos(function(files){ addPhotos(storeId,files).then(function(){ toast('写真を追加しました'); var ph=$('.rate-hero'); var u=coverURL(storeId); if(u) ph.innerHTML='<img src="'+u+'" alt="">'+ph.innerHTML.replace(/^<div class="ph">.*?<\/div>/,''); var badge=$('#rPhoto i'); var n=(S.photoIdx[storeId]||[]).length; if(badge) badge.textContent=n; else $('#rPhoto').insertAdjacentHTML('beforeend','<i>'+n+'</i>'); }); }); };
  $('#save').onclick=function(){
    addOrder(); var memo=$('#f-memo').value.trim(), date=$('#f-date').value;
    if (!cur.amb&&!cur.drink&&!cur.food&&!memo&&!orders.length){ toast('点数かメモを入れてください'); return; }
    var rec={storeId:storeId, amb:cur.amb, drink:cur.drink, food:cur.food, memo:memo, orders:orders.slice(), order:orders.join('、'), date:date, updated:Date.now()};
    DB.put('ratings',rec).then(function(){ S.ratings[storeId]=rec; S.rating=null; toast('保存しました'); openDetail(storeId); });
  };
}

function storeFormHTML(s, listId){
  var listOpts = [['free','その他のお店']].concat(S.lists.map(function(l){ return [l.id,l.name]; }));
  return '<div class="f"><label for="n-name">店名</label><input type="text" id="n-name" value="'+esc(s.name||'')+'" placeholder="例：珈琲 西武"></div>'+
    '<div class="f"><label for="n-addr">住所</label><input type="text" id="n-addr" value="'+esc(s.address||'')+'" placeholder="東京都新宿区新宿3-34-9"><div class="help"><button type="button" class="chip" id="useLoc">現在地を使う</button><button type="button" class="chip" id="geoAddr">住所から位置を調べる</button></div><div id="geoNote" style="font-size:11px;color:var(--muted)"></div></div>'+
    '<div class="f"><div class="row"><div><label for="n-pref">都道府県</label><input type="text" id="n-pref" list="prefs" value="'+esc(s.pref||'')+'" placeholder="東京都"><datalist id="prefs">'+PREF_ORDER.map(function(p){ return '<option value="'+p+'">'; }).join('')+'</datalist></div><div><label for="n-area">最寄り駅・エリア</label><input type="text" id="n-area" value="'+esc(s.area||'')+'" placeholder="新宿三丁目駅"></div></div></div>'+
    '<div class="f"><div class="row"><div><label for="n-tab">食べログURL</label><input type="url" id="n-tab" value="'+esc(s.tabelog||'')+'" placeholder="https://tabelog.com/…"></div><div><label for="n-closed">定休日</label><input type="text" id="n-closed" value="'+esc(s.closed||'')+'" placeholder="月曜"></div></div></div>'+
    (s.list==='kissa2026'||s.list.indexOf('tl:')===0 ? '' : '<div class="f"><label>入れるリスト</label><div class="help" id="listChips">'+listOpts.map(function(o){ return '<button type="button" class="chip'+(o[0]===(listId||s.list)?' on':'')+'" data-list="'+esc(o[0])+'">'+esc(o[1])+'</button>'; }).join('')+'<button type="button" class="chip ghost" id="newListInline">＋ 新しいリスト</button></div></div>');
}
function bindStoreForm(cur){
  $('#useLoc').onclick=function(){ $('#geoNote').textContent='現在地を取得中…'; locate().then(function(p){ if(!p){ $('#geoNote').textContent='位置情報が使えませんでした（設定で許可が必要です）'; return; } cur.lat=p.lat; cur.lng=p.lng; cur.approx=false; return reverseGeocode(p.lat,p.lng).then(function(a){ if(a.address) $('#n-addr').value=a.address; if(a.pref&&!$('#n-pref').value) $('#n-pref').value=a.pref; $('#geoNote').textContent='位置を記録しました（住所は目安。必要なら直してください）'; }); }).catch(function(){ $('#geoNote').textContent='住所の取得に失敗しました（位置は記録済み）'; }); };
  $('#geoAddr').onclick=function(){ var q=$('#n-addr').value.trim()||$('#n-name').value.trim(); if(!q){ toast('住所か店名を入れてください'); return; } $('#geoNote').textContent='検索中…'; forwardGeocode(q).then(function(g){ if(!g){ $('#geoNote').textContent='見つかりませんでした。番地まで入れると見つかりやすいです'; return; } cur.lat=g.lat; cur.lng=g.lng; cur.approx=false; $('#geoNote').textContent='位置を記録しました：'+g.display.slice(0,60); }).catch(function(){ $('#geoNote').textContent='検索に失敗しました（オフライン？）'; }); };
  $$('[data-list]').forEach(function(b){ b.onclick=function(){ $$('[data-list]').forEach(function(x){ x.classList.remove('on'); }); b.classList.add('on'); cur.list=b.dataset.list; }; });
  var nl=$('#newListInline'); if (nl) nl.onclick=function(){ var name=$('#inlineListName'); if (name){ return; } nl.insertAdjacentHTML('afterend','<input type="text" id="inlineListName" placeholder="例：うなぎ 百名店 2026" style="flex:1;min-width:160px;height:36px;border-radius:999px;border:1px solid var(--line2);background:var(--card);padding:0 12px;font-size:13px"><button type="button" class="chip on" id="inlineListOk">作成</button>'); $('#inlineListName').focus();
    $('#inlineListOk').onclick=function(){ var n=$('#inlineListName').value.trim(); if(!n) return; var l={id:uid('list'), name:n, created:Date.now()}; DB.put('lists',l).then(function(){ S.lists.push(l); cur.list=l.id; $('#inlineListName').remove(); $('#inlineListOk').remove(); $$('[data-list]').forEach(function(x){ x.classList.remove('on'); }); nl.insertAdjacentHTML('beforebegin','<button type="button" class="chip on" data-list="'+l.id+'">'+esc(n)+'</button>'); }); }; };
  $('#photoFromForm') && ($('#photoFromForm').onclick=function(){ pickPhotos(function(files){ cur._files=files; $('#photoFromForm').querySelector('span').textContent=files.length+' 枚選択済み'; exifGPS(files[0]).then(function(g){ if(!g) return; cur.lat=g.lat; cur.lng=g.lng; cur.approx=false; reverseGeocode(g.lat,g.lng).then(function(a){ if(a.address&&!$('#n-addr').value) $('#n-addr').value=a.address; if(a.pref&&!$('#n-pref').value) $('#n-pref').value=a.pref; $('#geoNote').textContent='写真の位置情報から住所を入れました'; }).catch(function(){}); }); }); });
}
function readStoreForm(cur){
  cur.name=$('#n-name').value.trim(); cur.address=$('#n-addr').value.trim(); cur.pref=$('#n-pref').value.trim()||'未設定'; cur.area=$('#n-area').value.trim(); cur.tabelog=$('#n-tab').value.trim(); cur.closed=$('#n-closed').value.trim();
  return cur;
}
function openNewStore(listId, files){
  var cur={id:uid('c'), list:listId||'free', approx:true, lat:null, lng:null, _files:files||null};
  openSheet('<div class="eyebrow">'+esc(listName(cur.list)||'その他のお店')+'</div><h2>お店を追加</h2><div class="meta">写真の位置情報や現在地から住所を入れられます</div>'+
    '<button type="button" class="photobox" id="photoFromForm"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><span>'+(files&&files.length?files.length+' 枚選択済み':'写真を撮る / ライブラリから選ぶ')+'</span><small>写真の位置情報から住所を入れます</small></button>'+
    storeFormHTML(cur, cur.list)+'<div class="acts"><button class="btn ghost sm" id="cancel">やめる</button><button class="btn" id="mk">追加して評価へ</button></div>');
  bindStoreForm(cur);
  if (files && files.length){ exifGPS(files[0]).then(function(g){ if(!g) return; cur.lat=g.lat; cur.lng=g.lng; cur.approx=false; reverseGeocode(g.lat,g.lng).then(function(a){ if(a.address) $('#n-addr').value=a.address; if(a.pref) $('#n-pref').value=a.pref; $('#geoNote').textContent='写真の位置情報から住所を入れました'; }).catch(function(){}); }); }
  $('#cancel').onclick=closeSheet;
  $('#mk').onclick=function(){ readStoreForm(cur); if(!cur.name){ toast('店名を入れてください'); return; } var f=cur._files; delete cur._files;
    DB.put('stores',cur).then(function(){ S.custom.push(cur); return f? addPhotos(cur.id,f):null; }).then(function(){ closeSheet(); if (cur.list!=='free'){ S.tab='other'; S.otherList=cur.list; } else S.tab='free'; saveUI(); openDetail(cur.id); openRate(cur.id); }); };
}
function openEditStore(s){
  var cur=Object.assign({}, s);
  openSheet('<div class="eyebrow">店の情報</div><h2>'+esc(s.name)+'</h2><div class="meta">'+(s.list==='kissa2026'||s.list.indexOf('tl:')===0?'百名店の店は住所と位置だけ編集できます（地図のピンが正確になります）':'')+'</div>'+
    storeFormHTML(cur, cur.list)+'<div class="acts"><button class="btn ghost sm" id="cancel">やめる</button>'+(s.list!=='kissa2026'&&s.list.indexOf('tl:')!==0?'<button class="btn danger sm" id="delStore">削除</button>':'')+'<button class="btn" id="ok">保存</button></div>');
  bindStoreForm(cur);
  if (s.list==='kissa2026'||s.list.indexOf('tl:')===0){ ['n-name','n-pref','n-area','n-tab','n-closed'].forEach(function(id){ $('#'+id).disabled=true; }); }
  $('#cancel').onclick=closeSheet;
  $('#ok').onclick=function(){ readStoreForm(cur);
    if (s.list==='kissa2026'||s.list.indexOf('tl:')===0){ var ov={id:s.id, address:cur.address, lat:cur.lat, lng:cur.lng, approx:cur.approx}; S.ov[s.id]=ov; DB.put('kv',{k:'ov-'+s.id, v:ov}).then(function(){ Object.assign(s, ov); closeSheet(); render(); toast('保存しました'); }); return; }
    DB.put('stores',cur).then(function(){ var i=S.custom.findIndex(function(x){ return x.id===cur.id; }); if(i>=0) S.custom[i]=cur; closeSheet(); render(); toast('保存しました'); }); };
  var d=$('#delStore'); if (d) d.onclick=function(){ confirmSheet('この店を削除しますか？','評価と写真も消えます。', function(){ var ps=S.photoIdx[s.id]||[]; Promise.all(ps.map(function(p){ return DB.del('photos',p.id); }).concat([DB.del('ratings',s.id), DB.del('stores',s.id)])).then(function(){ delete S.ratings[s.id]; delete S.photoIdx[s.id]; S.custom=S.custom.filter(function(x){ return x.id!==s.id; }); S.detail=null; render(); toast('削除しました'); }); }); };
}
function openNewList(preset){
  openSheet('<div class="eyebrow">他の百名店</div><h2>リストを追加</h2><div class="meta">食べログの百名店から選ぶか、自分で名前を付けて作れます</div><div class="search" style="margin-bottom:10px"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="lq" type="search" placeholder="ジャンルで検索（ラーメン、寿司…）" autocomplete="off"></div><div id="lrows" class="list-rows"><div class="empty" style="padding:20px">読み込み中…</div></div>'+
    '<div class="sec" style="margin-top:18px">自分で作る</div><div class="orderrow"><input type="text" id="l-name" value="'+esc(preset||'')+'" placeholder="例：行きたい純喫茶メモ" style="height:46px;border-radius:10px;border:1px solid var(--line2);background:var(--card);padding:0 12px;font-size:15px"><button type="button" class="btn sm" id="mk">作成</button></div>');
  var have={}; S.lists.forEach(function(l){ if (l.slug) have[l.slug]=1; });
  loadIndex().then(function(idx){
    var draw=function(q){ var items=idx.filter(function(e){ return !q || (e.title+e.slug).toLowerCase().indexOf(q.toLowerCase())>=0; });
      $('#lrows').innerHTML = items.length ? items.map(function(e){ return '<button data-slug="'+esc(e.slug)+'"'+(have[e.slug]?' style="opacity:.5"':'')+'>'+esc(e.title)+'<span>'+e.count+' 店'+(have[e.slug]?' · 追加済み':'')+'</span></button>'; }).join('') : '<div class="empty" style="padding:20px">見つかりません</div>';
      $$('[data-slug]',$('#lrows')).forEach(function(b){ b.onclick=function(){ addTabelogList(idx.filter(function(e){ return e.slug===b.dataset.slug; })[0]); }; }); };
    draw(''); $('#lq').oninput=function(e){ if (e.isComposing) return; draw(e.target.value.trim()); }; $('#lq').addEventListener('compositionend', function(e){ draw(e.target.value.trim()); });
  }).catch(function(){ $('#lrows').innerHTML='<div class="empty" style="padding:20px">リスト一覧を読み込めません（オフライン？）</div>'; });
  $('#mk').onclick=function(){ var n=$('#l-name').value.trim(); if(!n){ toast('リスト名を入れてください'); return; } var l={id:uid('list'), name:n, created:Date.now()}; DB.put('lists',l).then(function(){ S.lists.push(l); S.otherList=l.id; S.tab='other'; saveUI(); closeSheet(); render(); }); };
}
function addTabelogList(e){
  if (!e) return; var id='tl:'+e.slug, ex=listById(id);
  var go=function(){ S.otherList=id; S.tab='other'; saveUI(); closeSheet(); render(); };
  if (ex) return go();
  var l={id:id, name:e.title, kind:'tabelog', slug:e.slug, created:Date.now()};
  DB.put('lists',l).then(function(){ S.lists.push(l); go(); });
}
function openListPicker(){
  openSheet('<h2 style="font-size:22px">リストを選ぶ</h2><div class="meta">長押しで名前の変更・削除</div><div class="list-rows">'+S.lists.map(function(l){ var n=(l.kind==='tabelog'?(S.tl[l.slug]||[]):[]).concat(S.custom.filter(function(s){ return s.list===l.id; })), d=n.filter(function(s){ return S.ratings[s.id]; }); return '<button data-pick="'+l.id+'">'+esc(l.name)+'<span>'+d.length+' / '+(n.length||(l.kind==='tabelog'?'…':0))+' 軒</span></button>'; }).join('')+'</div><div class="acts"><button class="btn ghost" id="newL">＋ 新しいリスト</button></div>');
  $$('[data-pick]').forEach(function(b){ var t; b.onclick=function(){ S.otherList=b.dataset.pick; saveUI(); closeSheet(); render(); };
    b.addEventListener('touchstart',function(){ t=setTimeout(function(){ editList(b.dataset.pick); },600); },{passive:true}); b.addEventListener('touchend',function(){ clearTimeout(t); }); b.addEventListener('touchmove',function(){ clearTimeout(t); },{passive:true}); b.oncontextmenu=function(e){ e.preventDefault(); editList(b.dataset.pick); }; });
  $('#newL').onclick=function(){ openNewList(); };
}
function editList(id){
  var l=S.lists.filter(function(x){ return x.id===id; })[0]; if(!l) return;
  openSheet('<h2 style="font-size:22px">リストを編集</h2><div class="f" style="margin-top:12px"><label for="l-name">リスト名</label><input type="text" id="l-name" value="'+esc(l.name)+'"></div><div class="acts"><button class="btn danger sm" id="del">削除</button><button class="btn" id="ok">保存</button></div>');
  $('#ok').onclick=function(){ l.name=$('#l-name').value.trim()||l.name; DB.put('lists',l).then(function(){ closeSheet(); render(); }); };
  $('#del').onclick=function(){ var n=S.custom.filter(function(s){ return s.list===id; }).length; confirmSheet('「'+l.name+'」をタブから外しますか？', (l.kind==='tabelog'?'評価は残るので、同じリストを追加し直せば戻ります。':'')+(n?'自分で追加した '+n+' 軒は「その他のお店」に移ります。':''), function(){ if (l.slug) delete S.tl[l.slug]; var moves=S.custom.filter(function(s){ return s.list===id; }).map(function(s){ s.list='free'; return DB.put('stores',s); }); Promise.all(moves.concat([DB.del('lists',id)])).then(function(){ S.lists=S.lists.filter(function(x){ return x.id!==id; }); S.otherList=S.lists.length?S.lists[0].id:''; saveUI(); render(); }); }); };
}

/* ---------- record (camera first) ---------- */
function openRecord(){
  pickPhotos(function(files){
    var cands = allStores().filter(function(s){ return !S.ratings[s.id]; });
    var go=function(){
      var near = S.pos ? cands.map(function(s){ return {s:s,d:dist(S.pos,s)}; }).filter(function(x){ return x.d!=null && (!s_approxFar(x)); }).sort(function(a,b){ return a.d-b.d; }).slice(0,6) : [];
      function s_approxFar(x){ return x.s.approx && x.d>1.5; }
      openSheet('<div class="eyebrow">記録する</div><h2>どのお店ですか？</h2><div class="meta">'+files.length+' 枚の写真を選びました'+(near.length?' · 現在地に近い順':'')+'</div>'+
        '<div class="search" style="margin-bottom:10px"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="rq" type="search" placeholder="店名で検索" autocomplete="off"></div><div class="list-rows" id="rrows"></div>'+
        '<div class="acts"><button class="btn ghost" id="newS">リストにない店を追加</button></div>');
      var rows=$('#rrows');
      if (S.pos && window.OSM){ window.OSM.nearby(S.pos, 12, 0.4).then(function(ops){ if (!ops.length || !$('#rrows') || $('#rq').value) return;
        var have={}; near.forEach(function(x){ have[x.s.id]=1; });
        var extra=ops.filter(function(p){ return !(p.st&&have[p.st]); }).slice(0,10);
        rows.insertAdjacentHTML('beforeend','<div class="sec" style="margin:14px 0 4px">現在地の近くのお店</div>'+extra.map(function(p){ var c=window.OSM.CATS[p.cat]||window.OSM.CATS.o; return '<button data-osm="'+esc(p.id)+'"><span class="osm-dot" style="--c:'+c.color+'"></span>'+esc(p.name)+'<span>'+esc(c.label)+' · '+fmtDist(p._d)+'</span></button>'; }).join(''));
        $$('[data-osm]',rows).forEach(function(b){ b.onclick=function(){ var p=extra.filter(function(x){ return x.id===b.dataset.osm; })[0]; closeSheet(); adoptOsm(p).then(function(id){ return addPhotos(id,files).then(function(){ openDetail(id); openRate(id); }); }); }; });
      }); }
      var draw=function(q){ var items = q ? allStores().filter(function(s){ return s.name.toLowerCase().indexOf(q.toLowerCase())>=0; }).slice(0,30).map(function(s){ return {s:s,d:S.pos?dist(S.pos,s):null}; }) : near;
        rows.innerHTML = items.length ? items.map(function(x){ return '<button data-sel="'+x.s.id+'">'+esc(x.s.name)+'<span>'+esc(x.s.area||x.s.pref||'')+(x.d!=null?' · '+fmtDist(x.d):'')+(S.ratings[x.s.id]?' · 評価済み':'')+'</span></button>'; }).join('') : '<div class="empty" style="padding:20px">'+(q?'見つかりません':'検索して選んでください')+'</div>';
        $$('[data-sel]',rows).forEach(function(b){ b.onclick=function(){ var id=b.dataset.sel; closeSheet(); addPhotos(id,files).then(function(){ openDetail(id); openRate(id); }); }; }); };
      draw(''); $('#rq').oninput=function(e){ if (e.isComposing) return; draw(e.target.value.trim()); }; $('#rq').addEventListener('compositionend', function(e){ draw(e.target.value.trim()); });
      $('#newS').onclick=function(){ closeSheet(); openNewStore('free', files); };
    };
    if (!S.pos) locate().then(go); else go();
  });
}

/* ---------- map ---------- */
function renderMap(){
  $('#hdr').innerHTML='';
  var main=$('#main');
  main.innerHTML='<div id="map"></div><div class="map-ui"><div class="row"><div class="seg"><button data-mf="tab" class="'+(S.mapFilter==='tab'?'on':'')+'">'+esc(S.tab==='kissa2026'?'喫茶':S.tab==='other'?(listName(S.otherList)||'他の百名店'):'その他')+'</button><button data-mf="all" class="'+(S.mapFilter==='all'?'on':'')+'">すべて</button>'+(CL().user?'<button data-mf="fr" class="'+(S.mapFilter==='fr'?'on':'')+'">友だち</button>':'')+'</div><button class="iconbtn" id="me" aria-label="現在地へ"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg></button></div><div class="legend" id="legend"></div><div class="osm-bar" id="osmBar"></div><div class="osm-bar osm-sub" id="osmSub" hidden></div></div><div class="map-hint" id="mapHint" hidden></div><div class="map-card" id="mapCard" hidden></div>';
  if (typeof L==='undefined'){ main.innerHTML='<div class="empty"><b>地図を読み込めません</b>オフラインのときは地図タイルが表示できません</div>'; return; }
  if (S.map){ try{ S.map.remove(); }catch(e){} S.map=null; }
  if (S.mapFilter==='fr' && !CL().user) S.mapFilter='tab';
  var fr = S.mapFilter==='fr';
  var list = fr ? Object.keys(CL().shared||{}).map(function(id){ var s=findStore(id); if (s) return s; var e=CL().shared[id][0]; return {id:id, name:e.storeName, pref:e.pref, area:e.area, address:e.address, lat:e.lat, lng:e.lng, approx:e.approx, _shared:true}; })
    : S.mapFilter==='all' ? allStores() : stores();
  var withPos = list.filter(function(s){ return s.lat!=null; });
  var map = L.map('map',{zoomControl:false, attributionControl:true, tap:false}).setView([35.6895,139.7], 11);
  var osmRenderer = L.canvas({padding:0.3});
  var osmLayer = L.layerGroup().addTo(map);
  var pins = L.layerGroup().addTo(map);
  // 国土地理院の淡色地図（キー不要・日本語表記）。z5〜18、それ以上は拡大表示
  addBaseMap(map);
  S.map=map; window.__map=map; // 動作確認用
  var bounds=[];
  function drawPins(){
  if (S.map!==map) return;
  pins.clearLayers(); bounds=[]; var seen={};
  withPos = list.filter(function(s){ return s.lat!=null; });
  withPos.forEach(function(s){
    var key=s.lat.toFixed(4)+','+s.lng.toFixed(4); var k=(seen[key]=(seen[key]||0)+1); // 同じ駅の店は少しずらす
    var ang=k*2.4, rad=k>1?0.0012:0, lat=s.lat+Math.sin(ang)*rad, lng=s.lng+Math.cos(ang)*rad;
    var r=S.ratings[s.id], sc=score(r), f=fr?friendSum(s.id):null;
    var icon=f ? L.divIcon({className:'', html:'<div class="pin-f">'+fmtAvg(f.total)+'</div>', iconSize:[38,30], iconAnchor:[19,15]})
      : L.divIcon({className:'', html: r?'<div class="pin-v">'+fmtTotal(sc.total)+'</div>':'<div class="pin-u"></div>', iconSize:r?[34,34]:[18,18], iconAnchor:r?[17,17]:[9,9]});
    L.marker([lat,lng],{icon:icon, title:s.name}).addTo(pins).on('click',function(){ showMapCard(s); });
    bounds.push([lat,lng]);
  });
  }
  S.drawPins = drawPins;
  drawPins();

  /* 周辺のお店（OpenStreetMap） */
  var OSM=window.OSM, osmShown={}, osmSeq=0;
  function osmBar(){
    var bar=$('#osmBar'); if (!bar || !OSM) return;
    var cats=S.osmCats;
    bar.innerHTML='<button class="chip'+(S.osmOn?' on':'')+'" id="osmToggle">周辺のお店</button>'+(S.osmOn?'<button class="chip" id="osmFind" aria-label="店名で探す"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>探す</button><button class="chip'+(S.osmOpen?' on':'')+'" id="osmOpen">営業中</button>':'')+(S.osmOn?Object.keys(OSM.CATS).filter(function(k){ return k!=='o'; }).map(function(k){ var c=OSM.CATS[k], on=!cats||cats[k];
      return '<button class="chip osmc'+(on?' on':'')+'" data-oc="'+k+'" style="--c:'+c.color+'"><i></i>'+c.label+'</button>'; }).join(''):'');
    $('#osmToggle').onclick=function(){ S.osmOn=!S.osmOn; osmBar(); updateOsm(true); };
    var of=$('#osmFind'); if (of) of.onclick=openOsmSearch;
    var oo=$('#osmOpen'); if (oo) oo.onclick=function(){ S.osmOpen=!S.osmOpen; osmBar(); updateOsm(true); };
    $$('[data-oc]').forEach(function(b){ b.onclick=function(){ var k=b.dataset.oc; if (!S.osmCats){ S.osmCats={}; Object.keys(OSM.CATS).forEach(function(x){ S.osmCats[x]=true; }); }
      // 1つだけ選ぶ → それだけ表示。もう一度押すと全部に戻す
      var onlyThis = Object.keys(S.osmCats).filter(function(x){ return S.osmCats[x]; }).length===1 && S.osmCats[k];
      if (onlyThis) S.osmCats=null; else { Object.keys(S.osmCats).forEach(function(x){ S.osmCats[x]=(x===k); }); }
      S.osmCu=null;
      osmBar(); updateOsm(true); }; });
  }
  function oneCat(){ var c=S.osmCats; if (!c) return null; var on=Object.keys(c).filter(function(x){ return c[x]; }); return on.length===1 ? on[0] : null; }
  // 1つのジャンルを選んだときは、その中の細かい種類（寿司・そば など）で絞り込める
  function osmSub(pts){
    var el=$('#osmSub'); if (!el) return; var k=oneCat();
    if (!S.osmOn || !k){ el.hidden=true; el.innerHTML=''; return; }
    var cnt={}; pts.forEach(function(p){ if (p.cat===k && p.cu) cnt[p.cu]=(cnt[p.cu]||0)+1; });
    var top=Object.keys(cnt).sort(function(a,b){ return cnt[b]-cnt[a]; }).slice(0,12);
    if (S.osmCu && top.indexOf(S.osmCu)<0) top.unshift(S.osmCu);
    if (!top.length){ el.hidden=true; el.innerHTML=''; return; }
    el.hidden=false;
    el.innerHTML='<button class="chip'+(!S.osmCu?' on':'')+'" data-cu="">すべて</button>'+top.map(function(c){ return '<button class="chip'+(S.osmCu===c?' on':'')+'" data-cu="'+esc(c)+'">'+esc(c)+(cnt[c]?' <span class="n">'+cnt[c]+'</span>':'')+'</button>'; }).join('');
    $$('[data-cu]').forEach(function(b){ b.onclick=function(){ S.osmCu=b.dataset.cu||null; updateOsm(true); }; });
  }
  function openOsmSearch(){
    var card=$('#mapCard'); card.hidden=false;
    card.innerHTML='<div class="osm-find"><div class="r"><input id="ofq" type="search" placeholder="店名やジャンル（例：珈琲、寿司）" autocomplete="off" enterkeyhint="search"><button class="btn ghost sm" id="ofClose">閉じる</button></div><div class="sub" id="ofNote">地図の中心から約5kmの範囲を探します</div><div id="ofRes" class="of-res"></div></div>';
    var q=$('#ofq'), comp=false, t=null;
    function run(){ var v=q.value.trim(); if (!v){ $('#ofRes').innerHTML=''; return; } var c=map.getCenter();
      OSM.loadIndex().then(function(){ return OSM.search(v,{lat:c.lat,lng:c.lng},40); }).then(function(res){
        if (q.value.trim()!==v) return;
        $('#ofNote').textContent = res.length ? res.length+' 件（近い順）' : '見つかりませんでした（地図を動かすと範囲が変わります）';
        $('#ofRes').innerHTML=res.map(function(p,i){ var cc=OSM.CATS[p.cat]||OSM.CATS.o, op=OSM.isOpen(p.h);
          return '<button class="of-row" data-i="'+i+'"><span class="osm-dot" style="--c:'+cc.color+'"></span><span class="t"><b>'+esc(p.name)+'</b><small>'+esc([p.cu||cc.label, p.addr, p._d<3?('約'+Math.max(1,Math.round(p._d*1000/80))+'分'):p._d.toFixed(1)+'km', op===true?'営業中':''].filter(Boolean).join(' · '))+'</small></span></button>'; }).join('');
        $$('#ofRes [data-i]').forEach(function(b){ b.onclick=function(){ var p=res[+b.dataset.i]; map.setView([p.lat,p.lng],17); var st=p.st&&findStore(p.st); if (st) showMapCard(st); else showOsmCard(p); }; });
      }); }
    q.addEventListener('compositionstart',function(){ comp=true; });
    q.addEventListener('compositionend',function(){ comp=false; clearTimeout(t); t=setTimeout(run,200); });
    q.addEventListener('input',function(){ if (comp) return; clearTimeout(t); t=setTimeout(run,250); });
    q.addEventListener('keydown',function(e){ if (e.key==='Enter' && !e.isComposing && e.keyCode!==229){ e.preventDefault(); clearTimeout(t); run(); q.blur(); } });
    $('#ofClose').onclick=function(){ card.hidden=true; };
    card.onclick=function(e){ e.stopPropagation(); };
    setTimeout(function(){ q.focus(); }, 50);
  }
  function hint(t){ var h=$('#mapHint'); if (!h) return; h.hidden=!t; h.textContent=t||''; }
  function updateOsm(force){
    if (!OSM || S.map!==map) return;
    if (!S.osmOn){ osmLayer.clearLayers(); osmShown={}; hint(''); return; }
    var z=map.getZoom(), b=map.getBounds();
    OSM.loadIndex().then(function(){
      if (z<15){ osmLayer.clearLayers(); osmShown={}; osmSub([]); hint(OSM.keysIn(b.getSouth(),b.getWest(),b.getNorth(),b.getEast()).length||z<13?'拡大すると周辺のお店が出ます':''); return; }
      var my=++osmSeq;
      OSM.inBounds(b.getSouth(),b.getWest(),b.getNorth(),b.getEast()).then(function(pts){
        if (my!==osmSeq || S.map!==map) return;
        if (!pts.length){ hint('この辺りの周辺のお店データはまだありません（関東・関西・三重に対応）'); osmLayer.clearLayers(); osmShown={}; return; }
        var mine={}; S.custom.forEach(function(c){ mine[c.id]=1; });
        var cats=S.osmCats, keep={}, now=new Date(), nk=0;
        osmSub(pts);
        pts.forEach(function(p){
          if (cats && !cats[p.cat]) return;
          if (S.osmCu && p.cu!==S.osmCu) return;
          if (S.osmOpen && OSM.isOpen(p.h,now)!==true) return;
          if (p.st && findStore(p.st)) return;         // 百名店はリストのピンで出す
          if (mine['osm-'+p.id]) return;               // 記録した店は自分のピンで出す
          keep[p.id]=p; nk++;
        });
        hint(S.osmOpen ? (nk ? '営業中のお店 '+nk+' 軒（営業時間がわかる店だけ）' : 'この範囲に今営業中とわかるお店はありません') : '');
        if (force){ osmLayer.clearLayers(); osmShown={}; }
        Object.keys(osmShown).forEach(function(id){ if (!keep[id]){ osmLayer.removeLayer(osmShown[id]); delete osmShown[id]; } });
        Object.keys(keep).forEach(function(id){ if (osmShown[id]) return; var p=keep[id], c=OSM.CATS[p.cat]||OSM.CATS.o;
          osmShown[id]=L.circleMarker([p.lat,p.lng],{renderer:osmRenderer, radius:6, weight:1.5, color:'#fff', fillColor:c.color, fillOpacity:.95, bubblingMouseEvents:false}).addTo(osmLayer).on('click',function(){ showOsmCard(p); }); });
      });
    }).catch(function(){ hint(''); });
  }
  function showOsmCard(p){
    var card=$('#mapCard'); card.hidden=false; var c=OSM.CATS[p.cat]||OSM.CATS.o, d=S.pos?dist(S.pos,p):null;
    card.innerHTML='<div class="eyebrow" style="color:var(--muted);font-size:10px"><span class="osm-dot" style="--c:'+c.color+'"></span>'+esc(c.label)+(p.cu?' · '+esc(p.cu):'')+'</div>'+
      '<div class="r"><div style="flex:1;min-width:0"><div class="nm">'+esc(p.name)+'</div><div class="sub">'+esc([d!=null?(d<3?'徒歩 '+walkMin(d)+' 分':fmtDist(d)):'', p.addr, p.h?'営業 '+OSM.hoursJa(p.h):''].filter(Boolean).join(' · '))+'</div>'+(function(){ var o=OSM.isOpen(p.h); return o===true?'<div class="open-now on">営業中</div>':o===false?'<div class="open-now">営業時間外</div>':''; })()+'</div><button class="btn sm" id="ocRate">記録する</button></div>'+
      '<div style="display:flex;gap:8px"><a class="btn ghost sm" style="flex:1" target="_blank" rel="noopener" href="'+OSM.gmapsURL(p)+'">Googleマップ</a><a class="btn ghost sm" style="flex:1" target="_blank" rel="noopener" href="'+OSM.tabelogURL(p)+'">食べログで検索</a></div>';
    $('#ocRate').onclick=function(){ adoptOsm(p).then(function(id){ openDetail(id); openRate(id); }); };
  }
  osmBar();
  map.attributionControl.addAttribution('<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>');
  map.on('moveend', function(){ updateOsm(false); });
  map.on('click', function(){ var c=$('#mapCard'); if (c) c.hidden=true; });
  var done=list.filter(function(s){ return S.ratings[s.id]; }).length;
  $('#legend').innerHTML= fr ? '<span><i class="f"></i>友だちが行った '+list.length+'</span><span style="color:var(--muted)">数字はみんなの平均</span>' : '<span><i></i>行った '+done+'</span><span><i class="o"></i>未訪問 '+(list.length-done)+'</span>'+(withPos.some(function(s){ return s.approx; })?'<span style="color:var(--muted)">ピンは駅周辺の目安</span>':'');
  $$('[data-mf]').forEach(function(b){ b.onclick=function(){ S.mapFilter=b.dataset.mf; renderMap(); }; });
  $('#me').onclick=function(){ locate().then(function(p){ if(!p){ toast('位置情報が使えません'); return; } map.setView([p.lat,p.lng],14); drawMe(); nearestCard(); }); };
  function drawMe(){ if(!S.pos) return; if (S.meMarker) S.meMarker.remove(); S.meMarker=L.marker([S.pos.lat,S.pos.lng],{icon:L.divIcon({className:'',html:'<div class="pin-me"></div>',iconSize:[14,14],iconAnchor:[7,7]}),interactive:false}).addTo(map); }
  function nearestCard(){ if(!S.pos||fr) return; var unv=withPos.filter(function(s){ return !S.ratings[s.id]; }).map(function(s){ return {s:s,d:dist(S.pos,s)}; }).sort(function(a,b){ return a.d-b.d; }); if(!unv.length) return; showMapCard(unv[0].s, unv.slice(1,4)); }
  function showMapCard(s, others){
    var card=$('#mapCard'); card.hidden=false; var r=S.ratings[s.id], sc=score(r), d=S.pos?dist(S.pos,s):null, cu=coverURL(s.id), f=friendSum(s.id);
    card.innerHTML='<div class="eyebrow" style="color:var(--muted);font-size:10px">'+(r?'行った店':(d!=null?'ここから近い未訪問':'未訪問'))+'</div><div class="r">'+(cu?'<img src="'+cu+'" alt="" style="width:56px;height:56px;border-radius:10px;object-fit:cover">':'')+'<div style="flex:1;min-width:0"><div class="nm">'+esc(s.name)+'</div><div class="sub">'+esc([d!=null?(d<3?'徒歩 '+walkMin(d)+' 分':fmtDist(d)):'', s.area, s.closed?'定休 '+s.closed:''].filter(Boolean).join(' · '))+'</div>'+(f?'<div class="frline">みんな '+fmtAvg(f.total)+' · '+esc(f.entries.map(function(e){ return e.name; }).join('、'))+'</div>':'')+'</div>'+(r?'<div class="sc" style="font:26px var(--display);color:var(--amber)">'+fmtTotal(sc.total)+'</div>':'<button class="btn sm" id="mcRate">記録する</button>')+'</div>'+
      (others&&others.length?'<div class="others">'+others.map(function(o){ return '<span>'+esc(o.s.name)+' '+(o.d<3?walkMin(o.d)+'分':fmtDist(o.d))+'</span>'; }).join(''):'')+'</div>'+
      '<div style="display:flex;gap:8px"><button class="btn ghost sm" id="mcOpen" style="flex:1">詳細を見る</button><a class="btn ghost sm" style="flex:1" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(s.name+' '+(s.address||s.area||''))+'&travelmode=walking">Googleマップで経路</a></div>';
    $('#mcOpen').onclick=function(){ if (s._shared) openShared(s.id); else openDetail(s.id); }; var mr=$('#mcRate'); if (mr) mr.onclick=function(){ openDetail(s.id); openRate(s.id); };
  }
  if (S.pos){ map.setView([S.pos.lat,S.pos.lng],13); drawMe(); nearestCard(); }
  else if (bounds.length) map.fitBounds(bounds,{padding:[60,40], maxZoom:13});
  if (!S.pos) locate().then(function(p){ if(p&&S.map===map){ drawMe(); nearestCard(); } });
  setTimeout(function(){ map.invalidateSize(); updateOsm(true); },50);
}
// 周辺のお店を自分の「その他のお店」に入れる（正確な位置つき）
function adoptOsm(p){
  var id='osm-'+p.id;
  if (p.st && findStore(p.st)) return Promise.resolve(p.st);
  if (findStore(id)) return Promise.resolve(id);
  var ns={id:id, name:p.name, pref:p.pref||prefFromLatLng(p.lat,p.lng), area:p.addr||'', address:p.addr||'', lat:p.lat, lng:p.lng, approx:false, closed:'', genre:(window.OSM.CATS[p.cat]||{}).label||'', hours:window.OSM.hoursJa(p.h||''), list:'free', src:'osm'};
  return DB.put('stores',ns).then(function(){ S.custom.push(ns); return id; });
}
function prefFromLatLng(lat,lng){ if (lat>35.4&&lat<35.95&&lng>138.9&&lng<140) return '東京都'; if (lat>34.7&&lat<35.8&&lng>134.8&&lng<136.1) return '京都府'; if (lat>33.7&&lat<35.3&&lng>135.8&&lng<136.99) return '三重県'; return '未設定'; }

/* ---------- 地図の下地 ----------
   OpenFreeMap（OpenStreetMap）の「Liberty」スタイルを、日本語ラベル・細かい記号なしに整えて使う。
   WebGL が使えない・オフラインなどで読めないときは国土地理院の淡色地図にする。 */
var LIBERTY_URL='https://tiles.openfreemap.org/styles/liberty';
function gsiLayer(){ return L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',{minZoom:5, maxNativeZoom:18, maxZoom:19, attribution:'<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>'}); }
function hasWebGL(){ try { var c=document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2')||c.getContext('webgl'))); } catch(e){ return false; } }
function loadScript(src){ return new Promise(function(ok,ng){ var s=document.createElement('script'); s.src=src; s.onload=ok; s.onerror=ng; document.head.appendChild(s); }); }
function loadCss(href){ if (document.querySelector('link[href="'+href+'"]')) return; var l=document.createElement('link'); l.rel='stylesheet'; l.href=href; document.head.appendChild(l); }
var vectorLib=null;
function loadVectorLib(){
  if (vectorLib) return vectorLib;
  loadCss('vendor/maplibre/maplibre-gl.css');
  vectorLib = (window.maplibregl ? Promise.resolve() : loadScript('vendor/maplibre/maplibre-gl.js'))
    .then(function(){ return L.maplibreGL ? null : loadScript('vendor/maplibre/leaflet-maplibre-gl.js'); })
    .catch(function(e){ vectorLib=null; throw e; });
  return vectorLib;
}
// 見やすく整える：店や施設の記号・3Dの建物・一方通行の矢印・道路番号を消し、地名は日本語だけにする
function tidyStyle(j){
  var HIDE=/^(poi_r20|poi_r7|poi_r1|road_one_way_arrow|road_one_way_arrow_opposite|highway-shield-non-us|highway-shield-us-interstate|road_shield_us)$/;
  j.layers=j.layers.filter(function(l){ return !HIDE.test(l.id); });
  var JA=['coalesce',['get','name:ja'],['get','name:nonlatin'],['get','name']];
  j.layers.forEach(function(l){
    if (l.layout && l.layout['text-field'] && /name/.test(JSON.stringify(l.layout['text-field']))) l.layout['text-field']=JA;
    if (l.type==='fill-extrusion'){ l.paint=l.paint||{}; l.paint['fill-extrusion-height']=0; l.paint['fill-extrusion-base']=0; l.paint['fill-extrusion-opacity']=0.6; }
  });
  return j;
}
var libertyStyle=null;
function getStyle(){
  if (libertyStyle) return libertyStyle;
  libertyStyle = fetch(LIBERTY_URL).then(function(r){ if(!r.ok) throw new Error('style'); return r.json(); }).then(tidyStyle).catch(function(e){ libertyStyle=null; throw e; });
  return libertyStyle;
}
function addBaseMap(map){
  var fallback=function(){ if (S.map===map && !map._base){ map._base=gsiLayer().addTo(map); } };
  if (!hasWebGL() || !navigator.onLine){ fallback(); return; }
  var timer=setTimeout(fallback, 8000);  // 8秒で出なければ地理院地図にする
  Promise.all([loadVectorLib(), getStyle()]).then(function(r){
    clearTimeout(timer);
    if (S.map!==map || map._base) return;
    map._base=L.maplibreGL({style:r[1]}).addTo(map);  // 出典（OpenFreeMap・OpenMapTiles・OSM）はスタイルから自動で表示される
  }).catch(function(){ clearTimeout(timer); fallback(); });
}

/* ---------- stats ---------- */
function statsSegHTML(){ return CL().configured ? '<div class="seg2" style="margin-bottom:12px"><button data-sm="me" class="'+(S.statsMode==='me'?'on':'')+'">自分</button><button data-sm="all" class="'+(S.statsMode==='all'?'on':'')+'">みんな</button></div>' : ''; }
function bindStatsSeg(){ $$('[data-sm]').forEach(function(b){ b.onclick=function(){ S.statsMode=b.dataset.sm; render(); }; }); }
function renderFriends(){
  var c=CL();
  $('#hdr').innerHTML='<div class="hdr-top"><div><div class="eyebrow">百名店ノート</div><h1>みんな</h1></div></div>';
  var body='';
  if (!c.user) body='<div class="empty"><b>ログインすると見られます</b>設定からログインして、グループに参加してください</div><button class="btn" id="goSet">設定を開く</button>';
  else if (!((c.profile&&c.profile.groups)||[]).length) body='<div class="empty"><b>まだグループがありません</b>設定でグループを作って家族や友だちを招待するか、招待コードで参加してください</div><button class="btn" id="goSet">設定を開く</button>';
  else if (!c.feed.length) body='<div class="empty"><b>メンバーの記録はまだありません</b>誰かが評価を付けるとここに流れてきます</div>';
  else {
    var ids=Object.keys(c.shared), rank=ids.map(function(id){ var f=c.summary(id); return {id:id, f:f, e:f.entries[0]}; }).filter(function(x){ return x.f.total!=null; }).sort(function(a,b){ return b.f.total-a.f.total || b.f.n-a.f.n; }).slice(0,10);
    var byUser={}; c.feed.forEach(function(e){ byUser[e.uid]=byUser[e.uid]||{name:e.name,n:0,sum:0,k:0}; byUser[e.uid].n++; if (e.total!=null){ byUser[e.uid].sum+=e.total; byUser[e.uid].k++; } });
    var users=Object.keys(byUser).map(function(u){ return byUser[u]; }).sort(function(a,b){ return b.n-a.n; }), mx=users.length?users[0].n:1;
    body='<div class="stat" style="margin-bottom:10px"><div class="l">メンバーの訪問数</div><div class="bars" style="margin-top:10px">'+users.map(function(u){ return '<div><span>'+esc(u.name)+'</span><i style="width:'+(u.n/mx*100)+'%"></i><b>'+u.n+'</b></div>'; }).join('')+'</div></div>'+
      '<div class="stat" style="margin-bottom:10px"><div class="l">みんなのランキング</div><div class="list-rows">'+rank.map(function(x,i){ return '<button data-sh="'+esc(x.id)+'"><span style="color:var(--amber);font-family:var(--display);font-size:18px;width:28px;display:inline-block;flex-shrink:0">'+(i+1)+'</span><span class="rk-n">'+esc(x.e.storeName)+'</span><span>'+fmtAvg(x.f.total)+' · '+x.f.n+'人</span></button>'; }).join('')+'</div></div>'+
      '<div class="stat"><div class="l">最近の記録</div><div class="feed">'+c.feed.slice(0,40).map(function(e){
        return '<button class="fd" data-sh="'+esc(e.storeId)+'"><div class="fd-h"><b>'+esc(e.name)+'</b><span>'+esc(e.date?fmtDate(e.date):'')+'</span><span class="fr-t">'+fmtTotal(e.total)+'</span></div><div class="fd-s">'+esc(e.storeName)+'<small>'+esc([e.area,e.listName].filter(Boolean).join(' · '))+'</small></div>'+(e.memo?'<div class="fd-m">'+esc(e.memo.length>70?e.memo.slice(0,70)+'…':e.memo)+'</div>':'')+'</button>'; }).join('')+'</div></div>';
  }
  $('#main').innerHTML=statsSegHTML()+body;
  bindStatsSeg();
  var gs=$('#goSet'); if (gs) gs.onclick=function(){ S.view='settings'; render(); };
  $$('[data-sh]').forEach(function(b){ b.onclick=function(){ openShared(b.dataset.sh); }; });
}
function renderStats(){
  if (S.statsMode==='all' && CL().configured) return renderFriends();
  $('#hdr').innerHTML='<div class="hdr-top"><div><div class="eyebrow">百名店ノート</div><h1>統計</h1></div></div>'+tabsHTML();
  var all=stores(), done=all.filter(function(s){ return S.ratings[s.id]; }), scs=done.map(function(s){ return score(S.ratings[s.id]); }).filter(function(x){ return x.total!=null; });
  var avg=function(k){ var v=done.map(function(s){ return S.ratings[s.id][k]||0; }).filter(function(x){ return x>0; }); return v.length? (v.reduce(function(a,b){ return a+b; },0)/v.length):0; };
  var avgT = scs.length ? scs.reduce(function(a,b){ return a+b.total; },0)/scs.length : 0;
  var byPref={}; all.forEach(function(s){ byPref[s.pref]=byPref[s.pref]||{n:0,d:0}; byPref[s.pref].n++; if (S.ratings[s.id]) byPref[s.pref].d++; });
  var prefs=Object.keys(byPref).sort(function(a,b){ return byPref[b].n-byPref[a].n; }).slice(0,8);
  var top=done.map(function(s){ return {s:s,t:score(S.ratings[s.id]).total||0}; }).sort(function(a,b){ return b.t-a.t; }).slice(0,5);
  var months={}; done.forEach(function(s){ var d=S.ratings[s.id].date||''; if(d) months[d.slice(0,7)]=(months[d.slice(0,7)]||0)+1; }); var mk=Object.keys(months).sort().slice(-6);
  $('#main').innerHTML=statsSegHTML()+'<div class="stat-row"><div class="stat"><div class="l">訪問</div><div class="v">'+done.length+'<small> / '+(S.tab==='kissa2026'?100:all.length)+' 軒</small></div></div><div class="stat"><div class="l">平均合計</div><div class="v">'+(scs.length?avgT.toFixed(1):'–')+'<small> / 30</small></div></div></div>'+
    '<div class="stat" style="margin-bottom:10px"><div class="l">軸ごとの平均</div><div class="bars" style="margin-top:10px">'+AXES.map(function(a){ var v=avg(a[0]); return '<div><span>'+a[1].replace('お店の','')+'</span><i style="width:'+(v*10)+'%"></i><b>'+(v?v.toFixed(1):'–')+'</b></div>'; }).join('')+'</div></div>'+
    (prefs.length?'<div class="stat" style="margin-bottom:10px"><div class="l">エリア別の進み具合</div><div class="bars" style="margin-top:10px">'+prefs.map(function(p){ var x=byPref[p]; return '<div><span>'+esc(p)+'</span><i style="width:'+(x.d/x.n*100)+'%"></i><b>'+x.d+'/'+x.n+'</b></div>'; }).join('')+'</div></div>':'')+
    (mk.length?'<div class="stat" style="margin-bottom:10px"><div class="l">月ごとの訪問数</div><div class="bars" style="margin-top:10px">'+mk.map(function(m){ var mx=Math.max.apply(null,mk.map(function(k){ return months[k]; })); return '<div><span>'+m.replace('-','/')+'</span><i style="width:'+(months[m]/mx*100)+'%"></i><b>'+months[m]+'</b></div>'; }).join('')+'</div></div>':'')+
    (top.length?'<div class="stat"><div class="l">ベスト5</div><div class="list-rows">'+top.map(function(x,i){ return '<button data-open="'+x.s.id+'"><span style="color:var(--amber);font-family:var(--display);font-size:18px;width:28px;display:inline-block">'+(i+1)+'</span>'+esc(x.s.name)+'<span>'+fmtTotal(x.t)+'</span></button>'; }).join('')+'</div></div>':'<div class="empty">評価を記録すると統計が出ます</div>');
  bindHeader(); bindStatsSeg(); $$('[data-open]').forEach(function(b){ b.onclick=function(){ openDetail(b.dataset.open); }; });
}

/* ---------- account / groups ---------- */
function accountHTML(){
  var c=CL();
  if (!c.configured) return '';
  var head='<div class="stat acct" style="margin-bottom:10px"><div class="l">友だち・家族と共有</div>';
  if (!c.ready) return head+'<p class="note">'+esc(c.status||'接続中…')+(c.error?'<br>'+esc(c.error):'')+'</p></div>';
  if (!c.user) return head+
    (c.pendingJoin?'<p class="note hi">招待されています。ログインか新規登録をすると、そのままグループに参加できます。</p>':'<p class="note">ログインすると、記録がクラウドにも保存されて機種変更しても残り、グループの友だちや家族と評価を見せ合えます。写真は共有されません。</p>')+
    '<div class="seg2" id="amode"><button data-am="in" class="on">ログイン</button><button data-am="up">新規登録</button></div>'+
    '<div class="f" id="nameRow" hidden><label for="a-name">表示名（友だちに見える名前）</label><input id="a-name" maxlength="30" autocomplete="nickname" placeholder="例：とも"></div>'+
    '<div class="f"><label for="a-email">メールアドレス</label><input id="a-email" type="email" autocomplete="email" inputmode="email" autocapitalize="off"></div>'+
    '<div class="f"><label for="a-pw">パスワード（6文字以上）</label><input id="a-pw" type="password" autocomplete="current-password"></div>'+
    '<div class="err" id="a-err"></div>'+
    '<div class="acts" style="margin-top:4px"><button class="btn" id="a-go">ログイン</button></div>'+
    '<button class="linkbtn" id="a-reset">パスワードを忘れた</button></div>';
  var gids=(c.profile&&c.profile.groups)||[];
  var st = c.status || (c.error?c.error:(c.lastSync?'同期済み '+new Date(c.lastSync).toTimeString().slice(0,5):''));
  return head+
    '<div class="acct-me"><div><div class="nm">'+esc((c.profile&&c.profile.name)||'')+'</div><div class="sub">'+esc(c.user.email||'')+(st?' · '+esc(st):'')+'</div></div><button class="btn ghost sm" id="a-rename">名前を変える</button></div>'+
    '<div class="sec" style="margin-top:14px">グループ</div>'+
    (gids.length?gids.map(function(gid){ var g=c.groups[gid]||{}, names=Object.keys(g.memberNames||{}).map(function(u){ return g.memberNames[u]; });
      return '<div class="grp"><div class="grp-h"><b>'+esc(g.name||'読み込み中…')+'</b><span>'+((g.members||[]).length||names.length)+'人</span></div>'+
        (names.length?'<div class="grp-m">'+esc(names.join('、'))+'</div>':'')+
        '<div class="grp-a"><button class="btn sm" data-inv="'+gid+'">招待する</button><button class="btn ghost sm" data-leave="'+gid+'">抜ける</button></div></div>'; }).join('')
      :'<p class="note">まだグループがありません。作って招待するか、もらった招待コードで参加してください。</p>')+
    '<div class="acts" style="margin-top:10px"><button class="btn ghost sm" id="g-new" style="flex:1">＋ グループを作る</button><button class="btn ghost sm" id="g-join" style="flex:1">招待コードで参加</button></div>'+
    '<div class="acts" style="margin-top:10px"><button class="btn ghost sm" id="a-sync" style="flex:1">今すぐ同期</button><button class="btn ghost sm" id="a-out" style="flex:1">ログアウト</button></div></div>';
}
function bindAccount(){
  var c=CL(); if (!c.configured || !c.ready) return;
  if (!c.user){
    var mode='in';
    $$('[data-am]').forEach(function(b){ b.onclick=function(){ mode=b.dataset.am; $$('[data-am]').forEach(function(x){ x.classList.toggle('on', x===b); }); $('#nameRow').hidden = mode!=='up'; $('#a-go').textContent = mode==='up'?'登録してはじめる':'ログイン'; $('#a-pw').autocomplete = mode==='up'?'new-password':'current-password'; }; });
    $('#a-go').onclick=function(){
      var em=$('#a-email').value, pw=$('#a-pw').value, nm=($('#a-name').value||'').trim(), err=$('#a-err'); err.textContent='';
      if (mode==='up' && !nm){ err.textContent='表示名を入れてください'; return; }
      var b=$('#a-go'); b.disabled=true; b.textContent='確認中…';
      (mode==='up'?c.signUp(em,pw,nm):c.signIn(em,pw)).then(function(){ toast(mode==='up'?'登録しました':'ログインしました'); })
        .catch(function(e){ err.textContent=c.errMsg(e); b.disabled=false; b.textContent=mode==='up'?'登録してはじめる':'ログイン'; });
    };
    $('#a-reset').onclick=function(){ var em=$('#a-email').value.trim(), err=$('#a-err'); if(!em){ err.textContent='メールアドレスを入れてから押してください'; return; }
      c.resetPassword(em).then(function(){ err.textContent=''; toast('再設定のメールを送りました'); }).catch(function(e){ err.textContent=c.errMsg(e); }); };
    return;
  }
  $('#a-out').onclick=function(){ confirmSheet('ログアウトしますか？','この端末の記録は残ります。もう一度ログインすれば共有も再開します。', function(){ c.signOut().then(function(){ toast('ログアウトしました'); render(); }); }); };
  $('#a-sync').onclick=function(){ toast('同期中…'); Promise.resolve(c.sync()).then(function(){ toast('同期しました'); render(); }); };
  $('#a-rename').onclick=function(){
    openSheet('<h2 style="font-size:22px">表示名を変える</h2><div class="meta">グループのメンバーに見える名前です</div><div class="f"><label for="rn">表示名</label><input id="rn" maxlength="30" value="'+esc((c.profile&&c.profile.name)||'')+'"></div><div class="err" id="rn-err"></div><div class="acts"><button class="btn ghost sm" id="cancel">やめる</button><button class="btn" id="ok">保存</button></div>');
    $('#cancel').onclick=closeSheet; $('#ok').onclick=function(){ c.rename($('#rn').value).then(function(){ closeSheet(); toast('変更しました'); render(); }).catch(function(e){ $('#rn-err').textContent=c.errMsg(e); }); };
  };
  $('#g-new').onclick=function(){
    openSheet('<h2 style="font-size:22px">グループを作る</h2><div class="meta">作ったあと、招待コードを家族や友だちに送ります</div><div class="f"><label for="gn">グループ名</label><input id="gn" maxlength="40" placeholder="例：家族、喫茶部"></div><div class="err" id="gn-err"></div><div class="acts"><button class="btn ghost sm" id="cancel">やめる</button><button class="btn" id="ok">作る</button></div>');
    $('#cancel').onclick=closeSheet;
    $('#ok').onclick=function(){ var n=$('#gn').value.trim(); if(!n){ $('#gn-err').textContent='グループ名を入れてください'; return; } $('#ok').disabled=true;
      c.createGroup(n).then(function(gid){ toast('グループを作りました'); openInvite(gid, n); }).catch(function(e){ $('#ok').disabled=false; $('#gn-err').textContent=c.errMsg(e); }); };
  };
  $('#g-join').onclick=function(){ openJoin(''); };
  $$('[data-inv]').forEach(function(b){ b.onclick=function(){ var g=c.groups[b.dataset.inv]||{}; openInvite(b.dataset.inv, g.name||''); }; });
  $$('[data-leave]').forEach(function(b){ b.onclick=function(){ var g=c.groups[b.dataset.leave]||{};
    confirmSheet('「'+(g.name||'グループ')+'」から抜けますか？','このグループに共有した自分の評価は消えます（自分の記録は残ります）。招待コードがあればまた参加できます。', function(){ c.leaveGroup(b.dataset.leave).then(function(){ toast('抜けました'); render(); }).catch(function(e){ toast(c.errMsg(e)); }); }); }; });
}
function openInvite(gid, name){
  var c=CL(), url=c.inviteURL(gid), text='百名店ノートの「'+name+'」に招待します。\nアプリを開いてログインすると参加できます。\n'+url+'\n招待コード：'+gid;
  openSheet('<div class="eyebrow">招待する</div><h2>'+esc(name)+'</h2><div class="meta">このリンクかコードを送ってください。受け取った人はログイン後に参加できます。</div>'+
    '<div class="code" id="codeTxt">'+esc(gid)+'</div><div class="codeurl">'+esc(url)+'</div>'+
    '<div class="acts"><button class="btn ghost sm" id="copy" style="flex:1">コピー</button>'+(navigator.share?'<button class="btn" id="share" style="flex:1">LINEなどで送る</button>':'')+'</div><div class="acts" style="margin-top:8px"><button class="btn ghost sm" id="cancel" style="flex:1">閉じる</button></div>');
  $('#cancel').onclick=function(){ closeSheet(); render(); };
  $('#copy').onclick=function(){ (navigator.clipboard?navigator.clipboard.writeText(text):Promise.reject()).then(function(){ toast('コピーしました'); }).catch(function(){ var r=document.createRange(); r.selectNode($('#codeTxt')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('選択しました。長押しでコピーしてください'); }); };
  var sh=$('#share'); if (sh) sh.onclick=function(){ navigator.share({title:'百名店ノート', text:text}).catch(function(){}); };
}
function openJoin(code){
  var c=CL();
  openSheet('<h2 style="font-size:22px">招待コードで参加</h2><div class="meta">送られてきた12文字のコード（例：ABCD-EFGH-JKLM）</div><div class="f"><label for="jc">招待コード</label><input id="jc" autocapitalize="characters" autocomplete="off" value="'+esc(code||'')+'" placeholder="ABCD-EFGH-JKLM"></div><div class="err" id="jc-err"></div><div class="acts"><button class="btn ghost sm" id="cancel">やめる</button><button class="btn" id="ok">確認する</button></div>');
  $('#cancel').onclick=function(){ c.clearPendingJoin(); closeSheet(); };
  $('#ok').onclick=function(){ var err=$('#jc-err'); err.textContent='';
    c.peekGroup($('#jc').value).then(function(g){
      if ((g.members||[]).indexOf(c.user.uid)>=0){ c.clearPendingJoin(); closeSheet(); toast('すでに参加しています'); return; }
      openSheet('<div class="eyebrow">グループに参加</div><h2>'+esc(g.name)+'</h2><div class="meta">今 '+(g.members||[]).length+'人が参加しています</div><p class="note">参加すると、あなたの評価（点数・頼んだもの・メモ・訪問日・場所）がこのグループのメンバーに見えるようになります。写真は共有されません。</p><div class="err" id="jn-err"></div><div class="acts"><button class="btn ghost sm" id="cancel">やめる</button><button class="btn" id="ok">参加する</button></div>');
      $('#cancel').onclick=function(){ c.clearPendingJoin(); closeSheet(); };
      $('#ok').onclick=function(){ $('#ok').disabled=true; c.joinGroup(g.id).then(function(){ c.clearPendingJoin(); closeSheet(); toast('「'+g.name+'」に参加しました'); render(); }).catch(function(e){ $('#ok').disabled=false; $('#jn-err').textContent=c.errMsg(e); }); };
    }).catch(function(e){ err.textContent=c.errMsg(e); });
  };
}

/* ---------- settings / backup ---------- */
function renderSettings(){
  $('#hdr').innerHTML='<div class="hdr-top"><div><div class="eyebrow">百名店ノート</div><h1>設定</h1></div></div>';
  var nR=Object.keys(S.ratings).length, nP=Object.keys(S.photoIdx).reduce(function(a,k){ return a+S.photoIdx[k].length; },0);
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#main').innerHTML=accountHTML()+'<div class="stat" style="margin-bottom:10px"><div class="l">データ</div><p style="margin:8px 0 0;font-size:13px;color:var(--fg2);line-height:1.7">評価 '+nR+' 件 · 写真 '+nP+' 枚 · 追加した店 '+S.custom.length+' 軒<br>'+(CL().user?'ログイン中は写真以外がクラウドにも保存されます。写真はこのiPhoneの中だけなので、ときどきバックアップしてください。':'すべてこのiPhoneのブラウザ内に保存されています。機種変更やSafariのデータ削除で消えるので、ときどきバックアップしてください。')+'</p></div>'+
    '<div class="acts" style="margin-top:0"><button class="btn" id="exportBtn">バックアップを書き出す（zip）</button></div><div class="acts" style="margin-top:10px"><button class="btn ghost" id="importBtn">バックアップを読み込む</button></div>'+
    '<p style="font-size:11px;color:var(--muted);line-height:1.6">zipには data.json（評価・店・リスト）と写真が入ります。読み込みは同じIDのデータを上書きし、それ以外は残します。</p>'+
    (!standalone?'<div class="stat" style="margin-top:18px"><div class="l">ホーム画面に追加</div><p style="margin:8px 0 0;font-size:13px;color:var(--fg2);line-height:1.7">Safariの共有ボタン（□↑）→「ホーム画面に追加」で、アプリのように全画面で使えます。</p></div>':'')+
    '<div class="stat" style="margin-top:18px"><div class="l">このアプリについて · v1.6.1</div><p style="margin:8px 0 0;font-size:12px;color:var(--muted);line-height:1.7">食べログ 百名店の選出店データ（全71リスト、2026-10-19取得）を同梱。喫茶店 百名店 2026 は食べログ発表（2026年6月23日）の選出店。店の位置は最寄り駅周辺の目安（関東・関西の駅はOSMの駅位置）で、各店の「店の情報を編集」から住所と正確な位置を入れられます。地図: OpenFreeMap（© OpenMapTiles・© OpenStreetMap contributors、MapLibre で表示）。読めないときは国土地理院（地理院タイル）。周辺のお店（関東・関西・三重）: © OpenStreetMap contributors（ODbL、OpenFreeMap・Geofabrik経由）。住所検索: Nominatim（© OpenStreetMap contributors）。</p></div>'+
    '<div class="acts" style="margin-top:18px"><button class="btn ghost sm" id="forceUpdate" style="flex:1">最新版に更新</button><button class="btn danger sm" id="wipe" style="flex:1">すべてのデータを消す</button></div>'+
    '<p class="note">「最新版に更新」はアプリの部品だけを読み込み直します。記録や写真は消えません。</p>';
  bindAccount();
  $('#exportBtn').onclick=exportBackup;
  $('#importBtn').onclick=function(){ var inp=$('#importInput'); inp.value=''; inp.onchange=function(){ if (inp.files[0]) importBackup(inp.files[0]); }; inp.click(); };
  $('#forceUpdate').onclick=forceUpdate;
  $('#wipe').onclick=function(){ confirmSheet('本当にすべて消しますか？','評価・写真・追加した店がすべて消えます。バックアップを先に書き出してください。', function(){ Promise.all(['ratings','stores','lists','photos','kv'].map(DB.clear)).then(function(){ location.reload(); }); }); };
}
function forceUpdate(){
  toast('更新しています…');
  var jobs=[];
  if ('serviceWorker' in navigator) jobs.push(navigator.serviceWorker.getRegistrations().then(function(rs){ return Promise.all(rs.map(function(r){ return r.unregister(); })); }));
  if (window.caches) jobs.push(caches.keys().then(function(ks){ return Promise.all(ks.filter(function(k){ return k.indexOf('tiles')<0; }).map(function(k){ return caches.delete(k); })); }));
  Promise.all(jobs).catch(function(){}).then(function(){ location.replace(location.pathname + '?v=' + Date.now()); });
}
function exportBackup(){
  if (typeof JSZip==='undefined'){ toast('オフラインでは書き出せません'); return; }
  toast('書き出し中…');
  DB.all('photos').then(function(photos){
    var zip=new JSZip();
    var overrides = KISSA.filter(function(s){ return s.address || !s.approx; }).map(function(s){ return {id:s.id,address:s.address||'',lat:s.lat,lng:s.lng,approx:s.approx}; });
    zip.file('data.json', JSON.stringify({app:'hyakumeiten-note', v:1, exported:new Date().toISOString(), ratings:Object.keys(S.ratings).map(function(k){ return S.ratings[k]; }), stores:S.custom, lists:S.lists, overrides:overrides, photos:photos.map(function(p){ return {id:p.id,storeId:p.storeId,created:p.created,file:'photos/'+p.id+'.jpg'}; })}, null, 1));
    photos.forEach(function(p){ zip.file('photos/'+p.id+'.jpg', p.blob); });
    return zip.generateAsync({type:'blob', compression:'STORE'});
  }).then(function(blob){
    var name='hyakumeiten-note-'+todayStr()+'.zip', file=new File([blob], name, {type:'application/zip'});
    if (navigator.canShare && navigator.canShare({files:[file]})) return navigator.share({files:[file], title:'百名店ノート バックアップ'}).catch(function(){ dl(blob,name); });
    dl(blob,name);
  }).then(function(){ toast('書き出しました'); }).catch(function(e){ toast('書き出しに失敗: '+(e&&e.message||e)); });
  function dl(blob,name){ var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },2000); }
}
function importBackup(file){
  var isZip=/\.zip$/i.test(file.name);
  var p = isZip ? JSZip.loadAsync(file).then(function(z){ var dj=z.file('data.json'); if(!dj) throw new Error('data.json がありません'); return dj.async('string').then(function(t){ return {data:JSON.parse(t), zip:z}; }); }) : file.text().then(function(t){ return {data:JSON.parse(t), zip:null}; });
  p.then(function(x){ var d=x.data; if (d.app!=='hyakumeiten-note') throw new Error('このアプリのバックアップではありません');
    confirmSheet('バックアップを読み込みますか？', '評価 '+(d.ratings||[]).length+' 件、店 '+(d.stores||[]).length+' 軒、写真 '+(d.photos||[]).length+' 枚。同じIDのものは上書きされます。', function(){
      toast('読み込み中…');
      var ops=[];
      (d.ratings||[]).forEach(function(r){ ops.push(DB.put('ratings',r)); });
      (d.stores||[]).forEach(function(s){ ops.push(DB.put('stores',s)); });
      (d.lists||[]).forEach(function(l){ ops.push(DB.put('lists',l)); });
      (d.overrides||[]).forEach(function(o){ ops.push(DB.put('kv',{k:'ov-'+o.id, v:o})); });
      if (x.zip) (d.photos||[]).forEach(function(ph){ var f=x.zip.file(ph.file); if (f) ops.push(f.async('blob').then(function(b){ return DB.put('photos',{id:ph.id,storeId:ph.storeId,created:ph.created,blob:new Blob([b],{type:'image/jpeg'})}); })); });
      Promise.all(ops).then(function(){ return boot(); }).then(function(){ toast('読み込みました'); });
    });
  }).catch(function(e){ toast('読み込めません: '+(e&&e.message||e)); });
}

/* ---------- boot ---------- */
function applyOverrides(){
  return (window.OSM ? window.OSM.loadPositions() : Promise.resolve({})).then(function(pos){
    applyPositions(pos);
    Object.keys(S.ov).forEach(function(id){ var s=findStore(id); if (s) Object.assign(s, S.ov[id]); });
    queueGeocode(KISSA);
  });
}
// OSMと店名を照合して分かった百名店の正確な位置（自分で直した位置が優先）
function applyPositions(pos){ pos=pos||{}; var st=(window.OSM&&OSM.st)||{}; allStores().forEach(function(s){ if (S.ov[s.id]&&S.ov[s.id].lat!=null) return; var p=pos[s.id]; if (p && s.approx){ s.lat=p[0]; s.lng=p[1]; s.approx=false; s.posSrc='osm'; return; } var q=s.approx&&st[s.pref+'|'+s.area]; if (q){ s.lat=q[0]; s.lng=q[1]; } }); }
function boot(){ return load().then(applyOverrides).then(render); }

/* ---------- cloud との接続 ---------- */
var refreshT=null;
function refresh(){
  clearTimeout(refreshT);
  refreshT=setTimeout(function(){
    var a=document.activeElement;
    if (!$('#sheetWrap').hidden || S.rating || (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) return;
    if (S.view==='map' && !S.detail) return; // 地図は開き直したときに更新
    render();
  }, 250);
}
function applyRemote(coll, d){
  var o={noSync:true}, u=d.updated||0;
  if (coll==='ratings'){
    var l=S.ratings[d.storeId];
    if (d.deleted){ if (l && (l.updated||0) <= u){ delete S.ratings[d.storeId]; DB.del('ratings', d.storeId, o); return true; } return false; }
    if (!l || (l.updated||0) < u){ S.ratings[d.storeId]=d; DB.put('ratings', d, o); return true; }
    return false;
  }
  if (coll==='stores' || coll==='lists'){
    var arr = coll==='stores' ? S.custom : S.lists, i=-1;
    arr.forEach(function(x,j){ if (x.id===d.id) i=j; });
    var cur = i>=0 ? arr[i] : null;
    if (d.deleted){ if (cur && (cur.updated||0) <= u){ arr.splice(i,1); DB.del(coll, d.id, o); return true; } return false; }
    if (!cur || (cur.updated||0) < u){ if (i>=0) arr[i]=d; else arr.push(d); DB.put(coll, d, o); if (coll==='lists' && d.kind==='tabelog') loadTabelogList(d.slug).catch(function(){}); return true; }
    return false;
  }
  if (coll==='ov'){
    var c=S.ov[d.id]; if (c && (c.updated||0) >= u) return false;
    S.ov[d.id]=d; DB.put('kv', {k:'ov-'+d.id, v:d}, o); var st=findStore(d.id); if (st) Object.assign(st, d); return true;
  }
  return false;
}
function localAll(){
  var out=[];
  Object.keys(S.ratings).forEach(function(k){ out.push({coll:'ratings', v:S.ratings[k]}); });
  S.custom.forEach(function(v){ out.push({coll:'stores', v:v}); });
  S.lists.forEach(function(v){ out.push({coll:'lists', v:v}); });
  Object.keys(S.ov).forEach(function(k){ out.push({coll:'ov', v:S.ov[k]}); });
  return out;
}
function connectCloud(){
  var c=window.Cloud; if (!c || !c.configured) return;
  DB.onChange = function(op, store, v){ c.mirror(op, store, v); };
  c.attach({
    findStore:findStore, score:score, listName:listName, refresh:refresh, applyRemote:applyRemote, localAll:localAll,
    localRatings:function(){ return Object.keys(S.ratings).map(function(k){ return S.ratings[k]; }); },
    kvGet:function(k){ return DB.get('kv',k).then(function(r){ return r?r.v:null; }); },
    kvSet:function(k,v){ return DB.put('kv',{k:k,v:v},{noSync:true}); },
    reload:function(){ render(); },
    onPendingJoin:function(code){ S.view='settings'; S.detail=null; render(); openJoin(code); }
  });
  if (c.pendingJoin){ S.view='settings'; render(); }
}
document.addEventListener('DOMContentLoaded', function(){
  boot().then(connectCloud).catch(function(e){ $('#main').innerHTML='<div class="empty"><b>起動できませんでした</b>'+esc(e&&e.message||e)+'</div>'; });
  $$('#nav button').forEach(function(b){ b.onclick=function(){ var v=b.dataset.view; if (v==='record'){ openRecord(); return; } S.view=v; S.detail=null; S.rating=null; window.scrollTo(0,0); render(); }; });
  $('#scrim').onclick=closeSheet;
  window.addEventListener('popstate', function(){ if (!$('#sheetWrap').hidden) closeSheet(); else if (S.rating) closeRate(); else if (S.detail) closeDetail(); });
  if ('serviceWorker' in navigator){
    // 新しい版が入ったら一度だけ自動で読み直す（初回インストール時は読み直さない）
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function(){ if (!hadController || reloaded) return; reloaded = true; location.reload(); });
    navigator.serviceWorker.register('sw.js', {updateViaCache:'none'}).then(function(reg){
      reg.update().catch(function(){});
      document.addEventListener('visibilitychange', function(){ if (document.visibilityState==='visible') reg.update().catch(function(){}); });
    }).catch(function(){});
  }
});
})();
