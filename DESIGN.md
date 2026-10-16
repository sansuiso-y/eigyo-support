# 営業サポートサイト 設計書

## 目的
営業担当(1人〜少人数)が外回り中にスマホ/PCから使う、営業業務の一元管理サイト。
サーバー不要・インストール不要で、ブラウザだけで動く(データは端末内に保存、JSONでバックアップ可)。

## 想定ユーザー
旅館・ホテル等の営業担当。旅行会社・法人を訪問し、団体予約を獲得する。
出張が多く、自分のホテル・レンタカーの手配も必要。

## 機能一覧(画面)
| ルート | 画面 | 概要 |
|---|---|---|
| #/ | ダッシュボード | 今日の予定、未提出日報、直近の出張、やること |
| #/schedule | スケジュール | 月/週/日表示、予定の追加編集、訪問先(顧客)紐付け、添付 |
| #/customers | 顧客・名刺管理 | 名刺一覧/検索/タグ、名刺写真の保存、OCRでの読み取り(任意)、訪問履歴 |
| #/route | ルート作成 | 訪問先を選んで地図に表示、最適順序を提案(最近傍+2-opt)、OSRMで実走行距離・時間、Googleマップで開く |
| #/travel | 出張手配(ホテル/レンタカー) | 条件入力→各予約サイトを検索条件付きで開く、予約結果(確認番号等)を記録 |
| #/reports | 営業日報 | 日付を選ぶとその日の予定から自動下書き、編集、印刷/PDF、コピー |
| #/groups | 団体打ち合わせ表 | 団体受注の打ち合わせ表を作成・印刷 |
| #/files | 資料 | 添付ファイルの一覧(IndexedDB保存)、顧客/予定/日報への紐付け |
| #/settings | 設定 | 自分の名前・会社・出発地(拠点住所)、バックアップ(エクスポート/インポート) |

## 技術構成
- 静的HTML + vanilla JS(クラシック`<script>`、ビルド不要、file://でも動く)
- CSS: 自前(モバイル優先、ダークモード対応)
- 地図: Leaflet 1.9.4(CDN) + OpenStreetMap タイル
- 住所→座標: Nominatim(OpenStreetMap)
- 経路距離・時間: OSRM公開デモサーバー(失敗時は直線距離×1.3で推定)
- 名刺OCR: Tesseract.js(CDN、日本語+英語、任意機能)
- 保存: localStorage(構造化データ) + IndexedDB(添付ファイル・名刺画像)

## できないこと(正直に)
- ホテル・レンタカーの**実際の予約**は各社サイトで行う(本サイトは条件付きで検索ページを開き、結果を記録する)。
- データは端末のブラウザ内のみ。別端末と共有するには設定画面からJSONをエクスポート/インポート。

## データモデル(localStorage key: `sales.<collection>`)
```
customers:   {id, company, department, name, title, phone, mobile, email, zip, address, lat, lng, tags[], memo, cardImageId, createdAt, updatedAt}
events:      {id, date(YYYY-MM-DD), start(HH:MM), end, title, type(visit|meeting|move|other), customerId, address, lat, lng, memo, status(planned|done|cancelled), attachmentIds[]}
routes:      {id, date, name, startAddress, startLat, startLng, stops:[{customerId, label, address, lat, lng, stayMin}], distanceKm, durationMin, createdAt}
hotels:      {id, checkIn, checkOut, area, hotelName, price, confirmationNo, site, memo, status(searching|booked|cancelled)}
cars:        {id, pickupAt, returnAt, pickupPlace, returnPlace, company, carClass, price, confirmationNo, memo, status}
reports:     {id, date, weather, body(visits text), results, issues, tomorrow, attachmentIds[], status(draft|submitted), updatedAt}
groups:      {id, groupName, agency, agencyContact, agencyTel, arrival, departure, nights, pax{adult,child,infant}, rooms:[{type,count,capacity}], meals{dinner,breakfast,lunch}, banquet{room,start,end,style}, arrivalTime, departureTime, buses, rate, payment, notes, status, updatedAt}
settings:    {userName, company, homeAddress, homeLat, homeLng, workStart, workEnd, defaultStayMin}
attachments (IndexedDB 'files'): {id, name, type, size, blob, linkedKind, linkedId, createdAt}
```

## 共通API(js/store.js, js/ui.js, js/geo.js)
- `Store.list(col)`, `Store.get(col,id)`, `Store.save(col,obj)`(id無ければ付与)、`Store.remove(col,id)`, `Store.settings()`, `Store.saveSettings(obj)`, `Store.exportAll()`, `Store.importAll(json)`
- `Files.put(file, linkedKind, linkedId)`, `Files.get(id)`, `Files.list(linkedKind?, linkedId?)`, `Files.remove(id)`, `Files.url(id)`
- `UI.h(tag, attrs, ...children)`、`UI.modal({title, body, actions})`、`UI.toast(msg)`、`UI.confirm(msg)`、`UI.fmtDate`、`UI.today()`、`UI.uid()`
- `Geo.geocode(address)`→{lat,lng}、`Geo.route(points)`→{distanceKm, durationMin, geometry}、`Geo.optimize(start, stops, {roundTrip, fixedLast})`→`{order:[元index], stops:[並び替え済み], matrix}`、`Geo.gmapsUrl(points)`
- 添付の紐付けは Files の linkedKind/linkedId で管理(各モデルの attachmentIds は予備で常に空)。events には出張手配からの重複防止用に hotelId/carId が付くことがある。
- ページ登録: `App.register('schedule', {title:'スケジュール', icon:'📅', render(root, params){...}})`
