# Media Subscriber の保留キューに上限が無く Object を保持し続ける

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-subscriber-pending-queue-cap
- Polished: 2026-09-24

## 目的

closed の `0649-bug-media-subscriber-track-property-config.md` で、Track Property の config を初期 configure に反映するため、購読要求から初期 configure 完了までの Object を保留するキューを入れた。件数にもバイト数にも上限が無く、タイムアウトも無いため、`session.subscribe` が解決しない、または初期 configure がハングする場合に Object を無制限に保持し続ける。`close` 以外に解放の手段が無く、購読を続けたままメモリが増え続ける経路になる。catalog 側の `pendingCatalogObjects` には受信タイムアウトがあり、audio / video の保留キューだけが同型のガードを持たない。

## 現状

- `src/createMediaSubscriber.ts` の `pendingAudioObjects` / `pendingVideoObjects` (357-358 行目) は `MoqtObject[]` で、件数・バイト数の上限が無い。フィールド宣言のコメント (352-355 行目) も「上限は設けていない」と明記している
- 保留の有効化は `subscribeMediaTracks` が `audioInitialConfigPending` (964 行目) / `videoInitialConfigPending` (992 行目) を立てる時点で、`await session.subscribe(...)` より前である。SUBSCRIBE が応答しない場合、フラグは立ったままになる
- 保留中の Object は `handleAudioObject` (1119 行目) が 1121-1124 行目で、`handleVideoObject` (1256 行目) が 1258-1261 行目で積むだけである。上限判定も `onError` 通知も無い
- 解放は `applyInitialAudioConfig` (1033 行目) / `applyInitialVideoConfig` (1056 行目) の `finally` から `releasePendingAudioObjects` (1071 行目) / `releasePendingVideoObjects` (1081 行目) が行う。呼び出しは `await session.subscribe(...)` の直後 (984 行目 / 1020 行目) のため、subscribe が解決しない限り解放されない
- `close` は 505-508 行目で保留分とフラグを破棄する。購読中にメモリ増加を止める手段は `close` だけである
- catalog 側の `pendingCatalogObjects` (312 行目) も件数上限を持たないが、`subscribeCatalog` が `CATALOG_RECEIVE_TIMEOUT` (79 行目、5000 ms) のタイマー (617-632 行目) で `pendingCatalogObjects` を空にするため、無制限には伸びない
- 同型の上限の先例は `src/pendingSubgroupBuffer.ts` の `PendingSubgroupBufferOptions` (28-35 行目。`perStreamMaxBytes` 1 MiB / `perSessionMaxBytes` 16 MiB / `timeoutMs` 5000) と、それを露出する `MediaSubscriberOptions.pendingSubgroup` (`src/codec/types.ts` 137-140 行目) である
- `MediaSubscriberCallbacks` は `onError?: (error: Error) => void` を持ち (`src/codec/types.ts` 147 行目)、`MediaSubscriberImpl` からは `this.callbacks.onError?.(...)` の形で通知している (1105 行目 / 1220 行目 / 1252 行目 / 1342 行目)
- closed 0649 の「残した課題」に「保留キューに上限が無い (区間が伸びる異常時は Object を保持し続けるため、上限が必要になったら catalog 側の `pendingCatalogObjects` と同じ形で導入する)」と記録されている

## 設計方針

- 保留キューに件数とバイト数の上限を設ける。上限を超えた Object は保留せず破棄する。保持もしないため、上限ぶんのメモリで頭打ちになる
- 上限値は `PendingSubgroupBufferOptions` に倣った既定値を持つ定数として定義し、`MediaSubscriberOptions` から `Partial<...>` で上書きできるようにする (`pendingSubgroup` と同じ形。`src/codec/types.ts` に追加する)
- バイト数は `obj.payload.byteLength` を積算する。既存の受信統計 (`bytesReceived`) とは別に「保留中の合計バイト数」を持つ
- 超過は握り潰さず `this.callbacks.onError?.(...)` で通知する。ただし通知は購読期間ごとに 1 回だけにする。Object ごとに通知すると `onError` が溢れ、呼び出し側のログとエラー処理を圧迫する
- 破棄した Object は受信統計に数えない。統計の加算は保留判定より後 (音声 1151-1152 行目 / 映像 1300-1301 行目) にあり、保留中の Object も現状は統計に数えていない。破棄でも同じ扱いにし、統計の意味を変えない。破棄の発生は `onError` のメッセージで分かるようにする
- タイムアウトは入れない。保留区間の終端は `session.subscribe` の解決と初期 configure であり、購読が確立しない場合は Object 自体が届かない。バイト上限だけでメモリ増加は抑えられる
- 上限超過で破棄しても、既に保留している Object の解放 (初期 configure 完了後に到着順で処理する) は変えない。破棄は新規追加の拒否だけに限定する
- 通知の文言には、どちらの media か (audio / video)、上限値、累積バイト数を含める。ログメッセージは英語にする規約に従う
- `close` の破棄挙動とフラグの解除は変えない。上限超過の通知済みフラグも `close` と購読開始でリセットする
- `src/createMediaSubscriber.test.ts` に、上限超過で破棄され `onError` が 1 回だけ通知されること、上限内では従来どおり到着順に解放されること、`close` で保留分が破棄されることを固定するテストを追加する

## 完了条件

- `pendingAudioObjects` / `pendingVideoObjects` に件数とバイト数の上限があり、上限を超えた Object は保持されない
- 上限は `MediaSubscriberOptions` から上書きでき、既定値が定数として export されてテストで固定されている
- 上限超過時に `onError` が 1 回だけ通知される。同じ購読期間中に 2 回目以降の通知が出ない
- 上限内の Object は従来どおり初期 configure 完了後に到着順で処理される
- 上限超過で破棄された Object が受信統計に加算されない
- `close` の保留分破棄とフラグ解除の挙動が変わらない
- `CHANGES.md` の `## develop` に `[FIX]` が追記されている
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 Table 1 (VIDEO_CONFIG 0x0D / AUDIO_CONFIG 0x0F の Scope は Track, Object) / §2.3.2.1 (Video Config) / §2.3.3.1 (Audio Config)。`refs/moq/draft-ietf-moq-loc-04.txt`
- draft-ietf-moq-transport-21 §11.3.1 (Pending Subgroup の "brief period")。`src/pendingSubgroupBuffer.ts` の `perStreamMaxBytes` / `perSessionMaxBytes` / `timeoutMs` が上限の先例
- closed `0649-bug-media-subscriber-track-property-config.md` (保留キューの導入。残した課題に本件がある)

## 解決方法

{未着手}
