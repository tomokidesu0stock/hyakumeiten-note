/* 百名店ノート — cloud.js
   ログイン（メール＋パスワード）、自分の記録のクラウド同期、グループでの評価共有。
   Firebase（Auth / Firestore）を使う。window.FIREBASE_CONFIG が null なら何もしない。
   写真は送らない（端末内だけ）。 */
(function(){
'use strict';
var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
var SYNC_COLLS = ['ratings','stores','lists','ov'];

var C = window.Cloud = {
  configured: !!window.FIREBASE_CONFIG,
  ready: false, user: null, profile: null,
  groups: {},      // gid -> {name, owner, members[], memberNames{uid:name}}
  entries: {},     // gid -> [entry]
  shared: {},      // storeId -> [entry]（自分以外、最新のみ）
  feed: [],        // 自分以外の記録、新しい順
  status: '', lastSync: 0, error: ''
};
var api = null, unsubs = [], profUnsub = null, subscribedKey = '';

function loadScript(src){
  return new Promise(function(res, rej){
    var s = document.createElement('script'); s.src = src; s.async = false;
    s.onload = res; s.onerror = function(){ rej(new Error('読み込めません: '+src)); };
    document.head.appendChild(s);
  });
}
function clean(o){ return JSON.parse(JSON.stringify(o, function(k,v){ return v===undefined ? null : v; })); }
function now(){ return Date.now(); }
function notify(){ if (api && api.refresh) api.refresh(); }
function db(){ return C.db; }
function uref(){ return db().collection('users').doc(C.user.uid); }
function gref(gid){ return db().collection('groups').doc(gid); }
function myName(){ return (C.profile && C.profile.name) || (C.user && (C.user.displayName || (C.user.email||'').split('@')[0])) || '名無し'; }

C.attach = function(a){
  api = a;
  if (!C.configured) return Promise.resolve();
  C.status = '接続中…';
  return loadScript(SDK+'firebase-app-compat.js')
    .then(function(){ return Promise.all([loadScript(SDK+'firebase-auth-compat.js'), loadScript(SDK+'firebase-firestore-compat.js')]); })
    .then(function(){
      firebase.initializeApp(window.FIREBASE_CONFIG);
      C.auth = firebase.auth(); C.auth.languageCode = 'ja';
      C.db = firebase.firestore();
      if (window.FIREBASE_EMULATOR){ C.auth.useEmulator(window.FIREBASE_EMULATOR.auth); C.db.useEmulator(window.FIREBASE_EMULATOR.host, window.FIREBASE_EMULATOR.port); }
      return C.db.enablePersistence({synchronizeTabs:true}).catch(function(){});
    })
    .then(function(){
      C.ready = true; C.status = '';
      C.auth.onAuthStateChanged(onUser);
    })
    .catch(function(e){ C.status = 'オフライン'; C.error = e.message; notify(); });
};

/* ---------- auth ---------- */
var AUTH_MSG = {
  'auth/invalid-email':'メールアドレスの形が正しくありません',
  'auth/missing-password':'パスワードを入れてください',
  'auth/email-already-in-use':'このメールアドレスはもう登録されています。ログインしてください',
  'auth/weak-password':'パスワードは6文字以上にしてください',
  'auth/invalid-credential':'メールアドレスかパスワードが違います',
  'auth/invalid-login-credentials':'メールアドレスかパスワードが違います',
  'auth/wrong-password':'メールアドレスかパスワードが違います',
  'auth/user-not-found':'このメールアドレスは登録されていません',
  'auth/too-many-requests':'試行回数が多すぎます。少し待ってからもう一度',
  'auth/network-request-failed':'ネットにつながっていません'
};
C.errMsg = function(e){ return (e && AUTH_MSG[e.code]) || (e && e.code==='permission-denied' ? '権限がありません（コードが違うか、グループを外れています）' : (e && e.message) || String(e)); };
var pendingName = '';
C.signUp = function(email, pw, name){ pendingName = (name||'').trim().slice(0,30); return C.auth.createUserWithEmailAndPassword(email.trim(), pw).then(function(cr){ return cr.user.updateProfile({displayName: pendingName}); }); };
C.signIn = function(email, pw){ return C.auth.signInWithEmailAndPassword(email.trim(), pw); };
C.signOut = function(){ return C.auth.signOut(); };
C.resetPassword = function(email){ return C.auth.sendPasswordResetEmail(email.trim()); };

function onUser(u){
  stopAll();
  C.user = u; C.profile = null; C.groups = {}; C.entries = {}; C.shared = {}; C.feed = [];
  if (!u){ C.status=''; notify(); return; }
  C.status = '同期中…'; notify();
  var ref = uref();
  ref.get().then(function(d){
    if (d.exists) return d.data();
    var p = {name: pendingName || u.displayName || (u.email||'').split('@')[0], email: u.email||'', groups: [], created: now()};
    return ref.set(p).then(function(){ return p; });
  }).then(function(p){
    C.profile = p;
    profUnsub = ref.onSnapshot(function(d){ if (!d.exists) return; C.profile = d.data(); subscribeGroups(); notify(); }, function(){});
    subscribeGroups();
    return sync();
  }).then(function(){ checkPendingJoin(); })
  .catch(function(e){ C.status = '同期できませんでした'; C.error = C.errMsg(e); notify(); });
}
function stopAll(){ unsubs.forEach(function(f){ try{ f(); }catch(e){} }); unsubs = []; subscribedKey=''; if (profUnsub){ try{ profUnsub(); }catch(e){} profUnsub=null; } }

/* ---------- 同期（自分の記録） ---------- */
// 初めてこの端末でログインしたら全件を突き合わせ、2回目以降は前回からの変更だけ取る
function sync(){
  var uid = C.user.uid, key = 'cloud-sync-'+uid;
  return api.kvGet(key).then(function(last){
    last = last || 0; var full = !last;
    return Promise.all(SYNC_COLLS.map(function(coll){
      var q = uref().collection(coll);
      if (!full) q = q.where('updated','>', last - 5*60*1000);
      return q.get().then(function(snap){ return {coll:coll, docs:snap.docs.map(function(d){ return d.data(); })}; });
    })).then(function(res){
      var changed = false;
      res.forEach(function(r){ r.docs.forEach(function(d){ if (api.applyRemote(r.coll, d)) changed = true; }); });
      var push = Promise.resolve();
      if (full){
        // ローカルにしかない／ローカルの方が新しいものを送る
        var cloud = {}; res.forEach(function(r){ cloud[r.coll] = {}; r.docs.forEach(function(d){ cloud[r.coll][idOf(r.coll,d)] = d; }); });
        var ops = [];
        api.localAll().forEach(function(it){
          var c = cloud[it.coll][idOf(it.coll, it.v)];
          if (!c || (c.updated||0) < (it.v.updated||0)) ops.push(it);
        });
        push = writeOwn(ops).then(function(){ return Promise.all((C.profile.groups||[]).map(backfill)); });
      }
      return push.then(function(){
        var t = now(); C.lastSync = t; C.status = ''; C.error='';
        api.kvSet(key, t);
        if (changed) api.reload(); else notify();
      });
    });
  });
}
C.sync = function(){ if (C.user) return sync().catch(function(e){ C.error=C.errMsg(e); notify(); }); };
function idOf(coll, v){ return coll==='ratings' ? v.storeId : v.id; }
function writeOwn(items){
  var chunks = []; for (var i=0;i<items.length;i+=400) chunks.push(items.slice(i,i+400));
  return chunks.reduce(function(p, ch){ return p.then(function(){
    var b = db().batch();
    ch.forEach(function(it){ b.set(uref().collection(it.coll).doc(idOf(it.coll,it.v)), clean(Object.assign({}, it.v, {updated: it.v.updated||now()}))); });
    return b.commit();
  }); }, Promise.resolve());
}

// 端末内で何か保存・削除されたらクラウドにも反映（オフライン時はFirestoreが溜めて後で送る）
C.mirror = function(op, store, val){
  if (!C.user || !C.ready) return;
  try {
    var coll = store, id, data;
    if (store==='kv'){ if (op!=='put' || !val || String(val.k).indexOf('ov-')!==0) return; coll='ov'; data = Object.assign({}, val.v, {updated: (val.v&&val.v.updated)||now()}); id = data.id; }
    else if (SYNC_COLLS.indexOf(store)<0) return;
    else if (op==='put'){ data = Object.assign({}, val, {updated: val.updated||now()}); id = idOf(store, data); }
    else { id = val; data = store==='ratings' ? {storeId:id, deleted:true, updated:now()} : {id:id, deleted:true, updated:now()}; }
    uref().collection(coll).doc(id).set(clean(data)).catch(function(){});
    if (store==='ratings'){
      (C.profile && C.profile.groups || []).forEach(function(gid){
        var ref = gref(gid).collection('ratings').doc(C.user.uid+'__'+id);
        (op==='put' ? ref.set(groupEntry(data)) : ref.delete()).catch(function(){});
      });
    }
  } catch(e){ /* 共有に失敗しても端末内の保存は済んでいる */ }
};

function groupEntry(rec){
  var s = api.findStore(rec.storeId) || {}, sc = api.score(rec) || {};
  return clean({
    uid: C.user.uid, name: myName(), storeId: rec.storeId,
    storeName: s.name || '', list: s.list || '', listName: s.list ? api.listName(s.list) : '',
    pref: s.pref || '', area: s.area || '', address: s.address || '',
    lat: s.lat==null ? null : s.lat, lng: s.lng==null ? null : s.lng, approx: !!s.approx, tabelog: s.tabelog || '',
    amb: rec.amb||0, drink: rec.drink||0, food: rec.food||0, total: sc.total==null ? null : sc.total,
    orders: rec.orders || [], memo: String(rec.memo||'').slice(0,4000), date: rec.date || '', updated: rec.updated || now()
  });
}
function backfill(gid){
  var rs = api.localRatings();
  var chunks = []; for (var i=0;i<rs.length;i+=400) chunks.push(rs.slice(i,i+400));
  return chunks.reduce(function(p, ch){ return p.then(function(){
    var b = db().batch();
    ch.forEach(function(r){ b.set(gref(gid).collection('ratings').doc(C.user.uid+'__'+r.storeId), groupEntry(r)); });
    return b.commit();
  }); }, Promise.resolve());
}

/* ---------- グループ ---------- */
function subscribeGroups(){
  var gids = (C.profile && C.profile.groups || []).slice().sort(), key = gids.join(',');
  if (key === subscribedKey) return;
  unsubs.forEach(function(f){ try{ f(); }catch(e){} }); unsubs = []; subscribedKey = key;
  Object.keys(C.groups).forEach(function(g){ if (gids.indexOf(g)<0){ delete C.groups[g]; delete C.entries[g]; } });
  gids.forEach(function(gid){
    unsubs.push(gref(gid).onSnapshot(function(d){
      if (!d.exists){ delete C.groups[gid]; rebuild(); return; }
      var g = C.groups[gid] = Object.assign(C.groups[gid]||{memberNames:{}}, d.data(), {id:gid});
      notify();
    }, function(){ /* 外された等 */ }));
    unsubs.push(gref(gid).collection('members').onSnapshot(function(snap){
      var g = C.groups[gid] = C.groups[gid] || {id:gid, memberNames:{}};
      g.memberNames = {}; snap.docs.forEach(function(d){ g.memberNames[d.id] = d.data().name; });
      notify();
    }, function(){}));
    unsubs.push(gref(gid).collection('ratings').onSnapshot(function(snap){
      C.entries[gid] = snap.docs.map(function(d){ return d.data(); });
      rebuild();
    }, function(){ C.entries[gid] = []; rebuild(); }));
  });
  rebuild();
}
function rebuild(){
  var me = C.user && C.user.uid, best = {};
  Object.keys(C.entries).forEach(function(gid){ (C.entries[gid]||[]).forEach(function(e){
    if (!e || e.uid===me) return;
    var k = e.uid+'__'+e.storeId;
    if (!best[k] || (best[k].updated||0) < (e.updated||0)) best[k] = e;
  }); });
  var shared = {}, feed = [];
  Object.keys(best).forEach(function(k){ var e = best[k]; (shared[e.storeId] = shared[e.storeId]||[]).push(e); feed.push(e); });
  feed.sort(function(a,b){ return (b.updated||0)-(a.updated||0); });
  Object.keys(shared).forEach(function(k){ shared[k].sort(function(a,b){ return (b.updated||0)-(a.updated||0); }); });
  C.shared = shared; C.feed = feed;
  notify();
}

function genCode(){
  var a = new Uint32Array(12); crypto.getRandomValues(a);
  var s = ''; for (var i=0;i<12;i++){ s += CODE_CHARS[a[i] % CODE_CHARS.length]; if (i===3||i===7) s+='-'; }
  return s;
}
C.normCode = function(x){ var s = String(x||'').toUpperCase().replace(/[^A-Z0-9]/g,''); if (s.length!==12) return null; return s.slice(0,4)+'-'+s.slice(4,8)+'-'+s.slice(8); };
C.inviteURL = function(gid){ return location.origin + location.pathname + '?join=' + gid; };

function afterJoin(gid){
  return gref(gid).collection('members').doc(C.user.uid).set({name: myName(), joined: now()})
    .then(function(){ return uref().set({groups: firebase.firestore.FieldValue.arrayUnion(gid)}, {merge:true}); })
    .then(function(){ C.profile.groups = (C.profile.groups||[]).concat([gid]).filter(function(v,i,a){ return a.indexOf(v)===i; }); subscribeGroups(); return backfill(gid); })
    .then(function(){ return gid; });
}
C.createGroup = function(name){
  var gid = genCode();
  return gref(gid).set({name: String(name).trim().slice(0,40), owner: C.user.uid, members: [C.user.uid], created: now()}).then(function(){ return afterJoin(gid); });
};
C.peekGroup = function(code){
  var gid = C.normCode(code); if (!gid) return Promise.reject(new Error('招待コードは12文字です（例：ABCD-EFGH-JKLM）'));
  return gref(gid).get().then(function(d){ if (!d.exists) throw new Error('このコードのグループは見つかりません'); return Object.assign({id:gid}, d.data()); });
};
C.joinGroup = function(code){
  return C.peekGroup(code).then(function(g){
    if ((g.members||[]).indexOf(C.user.uid) >= 0) return afterJoin(g.id);
    return gref(g.id).update({members: firebase.firestore.FieldValue.arrayUnion(C.user.uid)}).then(function(){ return afterJoin(g.id); });
  });
};
C.leaveGroup = function(gid){
  var uid = C.user.uid;
  return gref(gid).collection('ratings').where('uid','==',uid).get().then(function(snap){
    var b = db().batch(); snap.docs.forEach(function(d){ b.delete(d.ref); }); return b.commit();
  }).catch(function(){})
  .then(function(){ return gref(gid).collection('members').doc(uid).delete().catch(function(){}); })
  .then(function(){ return gref(gid).update({members: firebase.firestore.FieldValue.arrayRemove(uid)}).catch(function(){}); })
  .then(function(){ return uref().set({groups: firebase.firestore.FieldValue.arrayRemove(gid)}, {merge:true}); })
  .then(function(){ C.profile.groups = (C.profile.groups||[]).filter(function(g){ return g!==gid; }); delete C.groups[gid]; delete C.entries[gid]; subscribeGroups(); });
};
C.rename = function(name){
  name = String(name||'').trim().slice(0,30); if (!name) return Promise.reject(new Error('名前を入れてください'));
  C.profile.name = name;
  return uref().set({name:name}, {merge:true})
    .then(function(){ return C.user.updateProfile({displayName:name}); })
    .then(function(){ return Promise.all((C.profile.groups||[]).map(function(gid){ return gref(gid).collection('members').doc(C.user.uid).set({name:name, joined: now()}, {merge:true}).then(function(){ return backfill(gid); }); })); });
};

/* ---------- 招待リンク（?join=CODE） ---------- */
C.pendingJoin = null;
(function(){
  try {
    var p = new URLSearchParams(location.search), j = p.get('join');
    if (j){ C.pendingJoin = C.normCode(j); history.replaceState(null, '', location.pathname); try{ localStorage.setItem('pendingJoin', C.pendingJoin||''); }catch(e){} }
    else { try{ C.pendingJoin = localStorage.getItem('pendingJoin') || null; }catch(e){} }
  } catch(e){}
})();
C.clearPendingJoin = function(){ C.pendingJoin = null; try{ localStorage.removeItem('pendingJoin'); }catch(e){} };
function checkPendingJoin(){ if (C.pendingJoin && api.onPendingJoin) api.onPendingJoin(C.pendingJoin); }

/* ---------- 集計 ---------- */
C.summary = function(storeId){
  var es = C.shared[storeId]; if (!es || !es.length) return null;
  var avg = function(arr){ arr = arr.filter(function(x){ return x!=null && x>0; }); return arr.length ? arr.reduce(function(a,b){ return a+b; },0)/arr.length : null; };
  return { n: es.length, total: avg(es.map(function(e){ return e.total; })),
    amb: avg(es.map(function(e){ return e.amb; })), drink: avg(es.map(function(e){ return e.drink; })), food: avg(es.map(function(e){ return e.food; })), entries: es };
};
})();
