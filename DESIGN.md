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
- 同期(任意): 同じフォルダの `server.js`(Node.js、依存なし)が index.html を配信しつつ `/api/data` と `/api/files` を提供。`js/store.js` 内の `Sync` が、サーバーがあれば保存のたびにサーバーへも書き、起動時・画面復帰時・30秒ごと・「今すぐ同期」でサーバーから読み直す。サーバーが無い/落ちている場合は従来どおり端末内のみで動く(フォールバック)。

## できないこと(正直に)
- ホテル・レンタカーの**実際の予約**は各社サイトで行う(本サイトは条件付きで検索ページを開き、結果を記録する)。
- 同期サーバー無しの場合、データは端末のブラウザ内のみ。別端末と共有するには `node server.js` を起動して同じWi-Fiから開くか、設定画面からJSONをエクスポート/インポート。
- 同期の競合解決は「最後に保存した方が勝つ」(コレクション単位・ファイル単位)。同時編集の自動マージはしない。

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

## 同期の仕組み(server.js / Store.Sync)
- 端末内(localStorage / IndexedDB)が常に一次保存先。ページの Store / Files 呼び出しAPIは変更なし。
- `Store.save/remove/saveSettings/importAll/clearAll` → localStorage 書き込み後、そのコレクションを 400ms デバウンスで `PUT /api/data/<col>`(settings は `PUT /api/data/settings`)。失敗時は `sales.sync.dirty` に記録し、次回接続時に再送。
- `Files.put/update` → IndexedDB 書き込み後 `PUT /api/files/<id>`(本文=blob、`X-File-Meta` ヘッダにメタ情報)。`Files.remove` → `DELETE /api/files/<id>`(失敗時は `sales.sync.fileDeletes` に記録して再送)。
- 取り込み(`Sync.now()`): `GET /api/status` で疎通確認 → 未送信分を push → `GET /api/data` でサーバー内容を localStorage に反映(未送信のコレクションは上書きしない)→ `GET /api/files` と IndexedDB を突き合わせ(サーバーにだけあれば取得、ローカルにだけあれば未送信なら送信・送信済みなら他端末で削除されたとみなして削除)→ 画面を再描画(モーダル編集中は再描画しない)。
- 実行タイミング: 起動時、タブが可視に戻ったとき、`online` イベント、30秒ごと(再描画せずリスナー通知のみ)、設定画面の「今すぐ同期」。
- サーバー側: `data/data.json`(exportAll と同じ形式 + updatedAt)、`data/files.json`(メタ情報)、`data/files/<id>`(本体)。書き込みは tmp → rename でアトミック。
- サーバーが空(初回)でローカルにデータがあれば、ローカル全体を `PUT /api/data` で送って初期化する。
- その端末からの初回接続(`sales.sync.lastAt` 未設定)で端末にもサーバーにもデータがある場合は、ID単位で合流(両方にあるIDは updatedAt の新しい方)してから `PUT /api/data` で送る。既存データを持つ2台目をつないでも消えない。
- `file://` で開いた場合は同期を試みない(`Sync.state().mode === 'none'`)。python http.server 等では `/api/status` が応答しないためオフライン扱い。

### API
| メソッド | パス | 内容 |
|---|---|---|
| GET | /api/status | `{app:'sales-support', updatedAt, files}` 疎通確認 |
| GET | /api/data | `{version, settings, data:{col:[...]}, updatedAt, empty}` |
| PUT | /api/data | 全体を置き換え(本文は exportAll 形式) |
| PUT | /api/data/:col | 1コレクション(配列)または settings(オブジェクト)を置き換え |
| GET | /api/files | メタ情報の配列 |
| GET/PUT/DELETE | /api/files/:id | 本体の取得/保存(本文=バイナリ、`X-File-Meta`=encodeURIComponent(JSON))/削除 |
