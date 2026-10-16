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
| #/plan | 営業計画 | 訪問先リストの取り込み(写真/PDFはAI読み取り、Excel/CSV、名刺から選択)→区分で絞り込み→希望日・時間帯の指定(手入力 or 「AIに注文」)→日ごとに自動振り分け+各日ルート最適化→予定表・ルートに一括反映。住所が無い行は「AIで住所を調べる」(Google検索付き、要確認) |
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
- `Store.save/remove/importAll(merge)` → localStorage 書き込み後、変更したレコードの id を `sales.sync.dirtyRecs`({col:{id:{op:'u'|'d', v}}})に記録し、400ms デバウンスで `PATCH /api/data/<col>` `{upsert:[...], delete:[...]}` を送る。送信中に同じレコードが再保存された場合は(`v` が変わるので)記録を消さず次回再送する。失敗時も記録が残り次回接続時に再送。
- `Store.clearAll/importAll(merge:false)` → `sales.sync.replaceCols` に記録し `PUT /api/data/<col>` で丸ごと置き換え。`saveSettings` → `sales.sync.dirtySettings` → `PUT /api/data/settings`(userName/theme を除く)。
- 競合は **レコード単位** で「後にサーバーへ届いた方が勝つ」。別のレコードの編集は互いに消さない。取り込み時、この端末で未送信のレコードはサーバーの版で上書きしない。
- `Files.put/update` → IndexedDB 書き込み後 `PUT /api/files/<id>`(本文=blob、`X-File-Meta` ヘッダにメタ情報)。`Files.remove` → `DELETE /api/files/<id>`(失敗時は `sales.sync.fileDeletes` に記録して再送)。
- 取り込み(`Sync.now()`): `GET /api/status` で疎通確認(404/501 かつその端末が一度も同期していなければ mode='static' にして以後同期しない。5xx や HTML 応答(Wi-Fi のログイン画面など)は一時障害としてオフライン扱いで、保存は未送信として残す)→ 未送信分を push → `GET /api/data` でサーバー内容を localStorage に反映(未送信レコードは端末の版を優先)→ `GET /api/files` と IndexedDB を突き合わせ(サーバーにだけあれば取得、ローカルにだけあれば未送信なら送信・送信済みなら他端末で削除されたとみなして削除)→ 画面を再描画(起動時・手動のみ。モーダル編集中は再描画しない)。
- 実行タイミング: 起動時・「今すぐ同期」(再描画あり)、タブが可視に戻ったとき・`online` イベント・30秒ごと(入力途中の内容を消さないよう再描画せず、リスナー通知+トーストのみ)。
- サーバーが空(`empty:true`、data/ を入れ替えた場合など)なら端末の内容で初期化し、添付の送信済み記録(`sales.sync.filesSynced`)もリセットして再送する(添付が「他端末で削除された」と誤判定されないため)。
- 初回接続の判定は `sales.sync.initDone`(取り込みが一度成功したか)。送信だけ成功しても初回マージは飛ばされない。
- サーバー側: `data/data.json`(exportAll と同じ形式 + updatedAt)、`data/files.json`(メタ情報)、`data/files/<id>`(本体)。書き込みは tmp → rename でアトミック。
- サーバーが空(初回)でローカルにデータがあれば、ローカル全体を `PUT /api/data` で送って初期化する。
- その端末からの初回接続(`sales.sync.lastAt` 未設定)で端末にもサーバーにもデータがある場合は、ID単位で合流(両方にあるIDは updatedAt の新しい方)してから `PUT /api/data` で送る。既存データを持つ2台目をつないでも消えない。
- `file://` で開いた場合は同期を試みない(`Sync.state().mode === 'none'`)。python http.server 等では `/api/status` が応答しないためオフライン扱い。

### 環境変数(server.js)
| 変数 | 内容 |
|---|---|
| `PORT` / 第1引数 | ポート(既定 8765) |
| `DATA_DIR` | 保存先ディレクトリ(既定 `./data`)。Cloud Run では GCS バケットを gcsfuse で `/data` にマウントして指定。tmp→rename が失敗する環境では直接書き込みにフォールバック |
| `SITE_PASSWORD` | 設定すると合言葉ログインが有効。未ログインは静的ファイル→`/login` へリダイレクト、`/api/*`→401 JSON。`POST /login` 成功で HttpOnly / SameSite=Lax の署名付きクッキー(30日、鍵は SITE_PASSWORD から SHA-256 派生、HMAC-SHA256)。比較は timingSafeEqual、連続失敗は IP ごとに最大30秒の待ち時間。`GET /logout` でクッキー削除。`/css/app.css` のみ未ログインでも配信(ログイン画面用) |
| `TRUST_PROXY=1` | Cloud Run 等のプロキシ配下: クッキーに Secure を付け、`X-Forwarded-For` をクライアントIPとして使う |

- 複数人共有のため、settings の `userName` と `theme` は端末ごとの値として同期対象外(localStorage のみ)。`/api/status` は `auth:true/false` を返し、設定画面はそれでログアウトリンクの表示を決める。クライアントが 401 を受けたら `/login` へ移動する。

### API
| メソッド | パス | 内容 |
|---|---|---|
| GET | /api/status | `{app:'sales-support', auth, updatedAt, files}` 疎通確認 |
| GET | /api/data | `{version, settings, data:{col:[...]}, updatedAt, empty}` |
| PUT | /api/data | 全体を置き換え(本文は exportAll 形式) |
| PUT | /api/data/:col | 1コレクション(配列)または settings(オブジェクト)を置き換え |
| PATCH | /api/data/:col | `{upsert:[record], delete:[id]}` をレコード単位で適用(同じ id は後着優先) |
| GET | /api/files | メタ情報の配列 |
| GET/PUT/DELETE | /api/files/:id | 本体の取得/保存(本文=バイナリ、`X-File-Meta`=encodeURIComponent(JSON))/削除 |

## サーバーAPI(server.js + ai.js、クラウド版)
- `GET /api/status` … {ai: GEMINI_API_KEY の有無, auth: 合言葉ログインの有無}
- `GET/PUT /api/data`, `PUT /api/data/<col>`, `/api/files/<id>` … 同期(server.js)
- `POST /api/extract` … 画像/PDF(本文=ファイル、Content-Type で種類)→ {rows:[{company,name,title,category,phone,address,memo}], note}。パスポート番号・生年月日・部屋番号は読み取らない
- `POST /api/assist` … {instruction, startDate, days, workStart, workEnd, rows:[{key,company,name,category,address,checked,date,timeFrom,timeTo}]} → {updates:[{key,date?,timeFrom?,timeTo?,checked?,stayMin?}], days?, startDate?, message}
- `POST /api/cards` … 名刺画像(本文=ファイル)→ {cards:[{company,department,name,nameKana,title,phone,mobile,fax,email,zip,address,website,memo}], note}。1枚に複数の名刺が写っていれば複数返す
- `POST /api/lookup` … {area, rows:[{key,company,name,hint}]} → {results:[{key,address,confidence,source,note}]}(Gemini の Google 検索グラウンディング)
- モデル: 環境変数 GEMINI_MODELS(既定 gemini-3.5-flash, 失敗時 gemini-2.5-flash)。キーは Secret Manager の GEMINI_API_KEY(社内共用)

## 営業計画の振り分けアルゴリズム(js/pages/plan.js buildPlan)
1. 全訪問先+出発地の所要時間行列を OSRM table で取得(失敗時は直線距離×1.3/35km/h)
2. 希望日のある行はその日に固定。時間帯(timeFrom)のある行は「固定時刻」として扱う
3. 各日: 出発地から、次の固定時刻(なければ業務終了)までに「移動+滞在+次への移動」が収まる最寄りを順に追加。固定時刻の行は到着が早ければ待つ。希望日指定なのに入らない行は入れて警告
4. 固定時刻のない日は 2-opt(Geo.optimize)で並べ直し。残りは「未割当」
5. 「予定表に反映」で events(type:visit, 到着/出発時刻)と routes(日ごと)を保存。未登録の訪問先は customers に登録

## 認証(auth.js、クラウド版 AUTH_REQUIRED=1)
- ユーザーは DATA_DIR/users.json(scrypt ハッシュ)。ログイン名は半角英数字 2〜32 文字、パスワード 8 文字以上。役割 admin / member。
- 初回: ユーザー0人のとき /setup で最初の管理者を作成(SETUP_CODE が設定されていればその入力が必須。Secret Manager の EIGYO_SITE_PASSWORD を流用)。
- セッション: 署名付きクッキー sales_session(30日)。鍵は SESSION_SECRET(Secret Manager EIGYO_SESSION_SECRET)、無ければ DATA_DIR/session-secret を自動生成。
- API: GET /api/me、POST /api/me/password {current,next}、管理者のみ GET/POST /api/users、PUT/DELETE /api/users/:id(自分の削除・最後の管理者の降格/削除は拒否)。
- ログイン失敗は IP ごとに 3 回目から待ち時間。/api/status に user を含め、設定画面の「アカウント」カードで表示・パスワード変更・メンバー管理を行う。
- ローカル(起動.command)では AUTH_REQUIRED 未設定のため認証なし。
