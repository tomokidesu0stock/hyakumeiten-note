# data/osm のライセンス

このフォルダの飲食店データは OpenStreetMap のデータから作成しています。

- © OpenStreetMap contributors — https://www.openstreetmap.org/copyright
- ライセンス：Open Database License (ODbL) 1.0 — https://opendatacommons.org/licenses/odbl/1-0/
- 取得元：OpenFreeMap（https://openfreemap.org ・ OpenMapTiles スキーマ、2026-10-11 版）、Geofabrik の地域データ（https://download.geofabrik.de ・ 関東／関西、2026-10-19 取得）および Overpass API
- 加工内容：関東（1都6県）と関西・三重（2府5県）の名前のある飲食店（amenity=restaurant/cafe/fast_food/bar/pub など、shop=bakery/confectionery など）を抽出し、重複を除いて約2km四方の区画に分割。OSM の cuisine（料理の種類）・opening_hours（営業時間）を付け、無い店は店名から大まかなジャンルを推定。都道府県・市区町村は OSM の行政界から付与。
- stations.json：同じデータの駅（railway=station/halt）の位置。百名店の「最寄り駅の目安」に使用。

このフォルダのデータベースは ODbL 1.0 で提供します。
