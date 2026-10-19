# 百名店ノート

行ったお店を「お店の雰囲気・飲み物・食事」の3軸（各10点）で記録する、自分用のiPhone向けPWA。
食べログ「百名店」全71リスト（約7,100店）を同梱。

## 公開手順（GitHub Pages）

1. GitHubにログインし、右上の「＋」→ **New repository**
   - Repository name: `hyakumeiten-note`（好きな名前でOK）
   - **Public** を選ぶ（Pagesの無料公開に必要）
   - ほかはそのまま **Create repository**
2. できたリポジトリの画面で **uploading an existing file** をクリック
   - この zip を展開した中身（`index.html` が一番上に来るように）をまとめてドラッグ＆ドロップ
   - 下の **Commit changes** を押す
3. リポジトリの **Settings** → 左メニュー **Pages**
   - Build and deployment → Source: **Deploy from a branch**
   - Branch: **main** / **/(root)** → **Save**
4. 1〜3分待つと、同じPages画面の上部に公開URLが出ます
   `https://<ユーザー名>.github.io/hyakumeiten-note/`
5. iPhoneのSafariでそのURLを開き、共有ボタン（□↑）→ **ホーム画面に追加**

### 更新するとき

GitHubの画面でファイルを差し替えて Commit すれば反映されます。
`sw.js` の `VERSION` を上げると、開いているiPhone側のキャッシュも確実に更新されます。

## データ

- 評価・写真・追加した店はすべて端末内（IndexedDB）。サーバーはありません
- 設定 →「バックアップを書き出す」で zip（data.json＋写真）を保存できます
- 店の位置は最寄り駅周辺の目安。詳細の「店の情報を編集」→「現在地を使う」で正確な位置に直せます

## 同梱データ

- `data/lists/*.json`: 食べログ百名店の選出店（店名・都道府県・最寄り駅・定休日・初選出・食べログURL）。各ジャンルの最新版（2026〜2022）。取得日 2026-10-19
- `js/data.js`: 喫茶店 百名店 2026（99店）と主要駅の座標

## 使っているもの

- 地図: Leaflet 1.9.4（vendor/ に同梱）＋ CARTO Dark タイル（© OpenStreetMap contributors, © CARTO）
- 住所・駅の検索: Nominatim（OpenStreetMap）
- zip: JSZip 3.10.1（vendor/ に同梱）
- 共有: Firebase Authentication / Cloud Firestore（設定は js/firebase-config.js、ルールは firestore.rules）
- フォント: Shippori Antique B1 / Noto Sans JP（Google Fonts）
