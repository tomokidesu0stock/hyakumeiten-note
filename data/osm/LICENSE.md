# data/osm のライセンス

このフォルダの飲食店データは OpenStreetMap のデータから作成しています。

- © OpenStreetMap contributors — https://www.openstreetmap.org/copyright
- ライセンス：Open Database License (ODbL) 1.0 — https://opendatacommons.org/licenses/odbl/1-0/
- 取得元：OpenFreeMap（https://openfreemap.org ・ OpenMapTiles スキーマ、2026-10-11 版）、Geofabrik の地域データ（https://download.geofabrik.de ・ 関東／関西、2026-10-19 取得）および Overpass API
- 加工内容：東京23区・京都市・伊勢市の範囲の飲食店（amenity=restaurant/cafe/fast_food/bar/pub など、shop=bakery/confectionery など）を抽出し、重複を除いて約2km四方の区画に分割。OSM の cuisine（料理の種類）・opening_hours（営業時間）を付け、無い店は店名から大まかなジャンルを推定。

このフォルダのデータベースは ODbL 1.0 で提供します。
