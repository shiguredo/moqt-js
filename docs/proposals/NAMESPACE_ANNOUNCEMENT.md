# 高レベル API の namespace 告知 (PUBLISH_NAMESPACE)

`createMediaPublisher` は catalog と媒体トラックの `PUBLISH` だけを送り、`PUBLISH_NAMESPACE` を送らない。
relay の namespace discovery は `PUBLISH_NAMESPACE` で登録された namespace だけを列挙するため、
高レベル API で作った配信は `SUBSCRIBE_NAMESPACE` で発見できない。
会議アプリは発見のためだけに制御プレーンの `Session` を低レベル API で別に張り、
そこで `PUBLISH_NAMESPACE` と `SUBSCRIBE_NAMESPACE` を行っている。

この文書は、`createMediaPublisher` に namespace を告知するオプションと、告知のライフサイクル (`done`) を持たせるための調査結果と設計案をまとめる。

- 調査日: 2026-11-02
- 調査基準: `74e4a8bb`
- 採否: 採用した。`MediaPublisherOptions.announceNamespace` と `MediaPublisher.namespacePublication` として実装し、公開 API の契約は [高レベル API](../HIGH_LEVEL_API.md) に記載している。この文書は判断の記録として残す

## 結論

- 高レベル API は接続した `Session` を内部に保持し、外から `publishNamespace` を呼ぶ入口が無い。
  このため会議アプリは別セッションを張っている
- 低レベル API には `Session.publishNamespace()` と `NamespacePublication.done()` があり、
  draft-22 の `PUBLISH_NAMESPACE` と撤回 (request のキャンセル) に対応している。
  高レベル API が同じセッションで呼べば、追加のセッションは要らない
- 告知の生存期間は session に紐づく。高レベル API の `stop()` と `close()` は session ごと閉じるため、
  告知は `start()` で作成し、解放で `done()` する。`pause()` と `resume()` では維持する。
  `stop()` からの再 `start()` は新しい session なので告知し直す
- 告知を外から観測し、告知だけを先に終えられるようにするなら、
  `MediaPublisher.namespacePublication` を公開する。告知だけを終えて配信を続けることは
  draft-22 §4.1 が許す
- 既定値、告知失敗時の扱い、`PUBLISH` との順序、空 namespace の拒否は検討事項であり、
  実装時に次のとおり決めた (「検討事項と決定」を参照)

## 期待の解釈

依頼は「`createMediaPublisher` に namespace を告知するオプションと、そのライフサイクル (`done`) を持たせる」である。
ここでは次の 2 つに分けて扱う。

- 告知の開始: `MediaPublisherOptions.announceNamespace` で指定し、`start()` が同一セッションで `PUBLISH_NAMESPACE` を送る
- 告知の終了: `NamespacePublication.done()` を返し、`stop()` と `close()` の解放で呼ぶ。
  利用者が明示的に `done()` を呼ぶ経路も残す

購読側の `SUBSCRIBE_NAMESPACE` を高レベル API に足すことは本提案の範囲外とする。
会議アプリは発見の購読を制御プレーンの session で続ける。

## 仕様の根拠

draft-ietf-moq-transport-23 §4 (Publisher and Namespace Discovery) より。

- §4.1: publisher は `PUBLISH_NAMESPACE` を送ってよい (MAY)。
  `PUBLISH_NAMESPACE` は prefix に一致する namespace にトラックがあることを示す
- §4.1: `PUBLISH_NAMESPACE` の撤回は request のキャンセル (§6.4.2.3 の RESET_STREAM と STOP_SENDING) で行う。
  draft-22 に `PUBLISH_NAMESPACE_DONE` は無い
- §4.2: publisher が namespace を知っている条件は「その namespace の 1 つ以上のトラックの
  Original Publisher である」または「relay が権限のある `PUBLISH_NAMESPACE` を受けた」ことである。
  relay は上流から `PUBLISH` を受けただけでは Original Publisher ではないため、
  上流 publisher の `PUBLISH_NAMESPACE` が discovery の登録条件になる
- §4.2: 撤回した namespace は `NAMESPACE_DONE` として `SUBSCRIBE_NAMESPACE` の購読者へ伝わる。
  `PUBLISH` で確立した購読は `SUBSCRIBE_NAMESPACE` の stream の終了に影響されない
- §9.14: `PUBLISH_NAMESPACE` に載せられるパラメータは `AUTHORIZATION_TOKEN` だけである
- draft-ietf-moq-msf-01 §11.4.3: original publisher のトークンは `PUBLISH` と
  `PUBLISH_NAMESPACE` の両方へ MUST 付与する

会議での観測 (relay は `PUBLISH_NAMESPACE` で登録された namespace だけを列挙する) は、
この §4.2 の条件と整合する。relay が `PUBLISH` から namespace を推測して列挙することは
仕様上求められていない。

## 現状の実装

### 高レベル API

- `MediaPublisherImpl` は session を private フィールドで保持し、
  公開インターフェース (`MediaPublisher`) に session を読む入口が無い (`src/createMediaPublisher.ts`)
- `start()` は接続、音声の配送方式の検査、catalog と音声と映像の `PUBLISH`、音声の取り出し経路、
  catalog の送信、encoder の設定、処理ループの起動の順に進む (調査時点では
  `PUBLISH_NAMESPACE` を送る段が無かった。実装後は `PUBLISH` の後に告知する)
- `stop()` と `close()` は `disposeAllResources()` で publisher の `done()` と session の `close()` を行い、
  session を破棄する
- `pause()` と `resume()` は session を維持したまま処理ループだけを止める
- `start()` の失敗時も `disposeAllResources()` で巻き戻す

### 低レベル API

- `Session.publishNamespace(namespace, callbacks?, options?)` は専用の双方向ストリームで
  `PUBLISH_NAMESPACE` を送り、`REQUEST_OK` で `NamespacePublication` を返す
  (`src/session.ts`、`src/session/namespaces.ts`)
- `NamespacePublication` は `state` (active / closed)、`namespace`、`done()` を持つ
  (`src/session/publicTypes.ts`)
- `done()` は RESET_STREAM と STOP_SENDING で request をキャンセルし、状態を閉じる。
  `PUBLISH_NAMESPACE_DONE` は送らない
- session の終了時は publication の state を閉じ、未確立の Promise を reject し、
  `namespacePublications` を clear する (`src/session/lifecycle.ts`)。そのため終了済み
  session の `done()` は何もしない
- `REQUEST_ERROR` では Promise が reject する前に `error` コールバックも呼ばれる
  (`src/session/namespaceLoops.ts`)。高レベル API からコールバックを渡す場合、
  `start()` の失敗通知と二重にならないようにする必要がある
- 認可トークンは `PublishNamespaceOptions.authorizationToken` で渡す。
  SETUP の登録状況に応じて USE_ALIAS / USE_VALUE へ正規化される

### 実リレーでの検証状況

- このリポジトリに relay の実装は無い (クライアント専用。`CODEBASE.md`)
- リレー実装側は `PUBLISH_NAMESPACE` / `SUBSCRIBE_NAMESPACE` / `NAMESPACE` / `NAMESPACE_DONE`
  に対応していることを 2026-11-02 に確認した
- 2026-10-03 に実リレーで試したときは `SUBSCRIBE_NAMESPACE` に応答が無かった。
  その後のリレー実装の更新で解消している可能性がある
- 2026-11-02 に実装後の実リレーで往復を確認した。
  `tests/e2e/relay/namespace-announcement.spec.ts` が `PUBLISH_NAMESPACE` →
  `SUBSCRIBE_NAMESPACE` → `NAMESPACE` → 撤回 → `NAMESPACE_DONE` を通す (1 passed)
- 2026-11-03 に、発見した namespace のトラックを `SUBSCRIBE` して映像を受信する経路を
  実リレーで確認した。`tests/e2e/relay/namespace-discovery-subscribe.spec.ts` が
  `PUBLISH_NAMESPACE` → `SUBSCRIBE_NAMESPACE` → `NAMESPACE` → 発見した namespace の
  `SUBSCRIBE` → 映像の受信を通す (1 passed)

## 設計案

### API

```typescript
interface MediaPublisherOptions {
  // 既存のフィールドは省略
  // namespace を PUBLISH_NAMESPACE で告知する (実装した名前と既定値: announceNamespace、false)
  announceNamespace?: boolean;
}

interface MediaPublisher {
  // 既存のメンバーは省略
  // 現在の namespace 公開。announceNamespace が無効、start 前と実行中、stop / close 後は null
  readonly namespacePublication: NamespacePublication | null;
}
```

`NamespacePublication` は低レベル API の公開型をそのまま使う。
`state` と `namespace` を読め、`done()` で告知だけを終えられる。

### ライフサイクル

| 契機                     | 告知の扱い                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `start()`                | 接続し、`PUBLISH` の確立後に `PUBLISH_NAMESPACE` を送り、`REQUEST_OK` を待って保持する。失敗したら開始を失敗させる |
| `pause()` / `resume()`   | 変更しない (トラックは在り、購読は継続できる)                                                                      |
| `stop()` / `close()`     | 解放で `done()` を 1 回呼ぶ。`stop()` からの再 `start()` は新しい session で告知し直す                             |
| ピア起点の close         | session の終了で publication は閉じる。ローカルの参照は解放で切る。`done()` は状態が closed のため何もしない       |
| `start()` の失敗         | 巻き戻しの解放で `done()` を呼ぶ。告知の確立前に失敗した場合は告知が無いため何もしない                             |
| 利用者が `done()` を呼ぶ | 告知だけを終え、配信は続ける。再 `start()` では再告知する                                                          |

解放では告知の `done()` を publisher の `done()` より前に置く。
新規の購読者に停止中の配信を発見させないためである。
リレー実装によっては、セッションの切断だけでは購読者へ `NAMESPACE_DONE` が届かないため、
告知の撤回は `done()` で明示的に送る。
`NAMESPACE_DONE` は既存の `PUBLISH` 購読に影響しない (§4.2)。

### 告知の位置

`createPublishers()` の後、`prepareAudioFrameSource()` の前に置く (実装済み)。

- 採用: `PUBLISH` を確立してから告知する。§4.1 の「prefix に一致する namespace にトラックがある」という
  表明と一致し、告知の失敗で `start()` が失敗する場合も PUBLISH の巻き戻しは既存の解放経路に乗る
- 代替: `PUBLISH` より前に告知する。relay が `PUBLISH_NAMESPACE` を拒否する場合に PUBLISH を送らずに
  失敗できる。反面、トラックが確立する前に namespace を告知する短い窓ができる。
  規格上の順序要求は無い

実装は採用側の順序であり、2026-11-02 の実リレーで `PUBLISH` の後に送る告知の往復を確認した。
単体テストは catalog の `PUBLISH` との順序を固定し、音声・映像の `PUBLISH` との順序は await の
位置で保証する。

### 実装箇所

- `src/codec/types.ts`: `MediaPublisherOptions.announceNamespace` と `MediaPublisher.namespacePublication`
- `src/createMediaPublisher.ts`: `namespacePublication` フィールド、`start()` の告知、
  `disposeAllResources()` の `done()`、getter
- `src/session/namespaces.ts`: 未確立の publication に reject を登録する
- `src/session/lifecycle.ts`: Session 終了時に未確立の namespace publication の Promise を reject する
- `src/session/namespaceLoops.ts`: 確立後に reject を外す (`namespaceStartPublicationStreamLoop`)
- `src/session/types.ts`: `NamespacePublicationState` に確立前の reject を保持するフィールド

当初は低レベル API の変更を不要としていたが、Session の終了時に未確立の
`publishNamespace()` の Promise が settle しない穴があったため、低レベルの 4 ファイルを変更した。

告知を `start()` に足すと await の窓が 1 つ増える。
告知の await 中に `close()` またはピア起点の close が先行する場合があるため、
既存の `assertStartNotDisposed(startGeneration)` と同じ検査を告知の後にも置く (実装済み)。
告知の Promise が解決したあとに解放が先行していたら `assertStartNotDisposed` で失敗し、
その後の `disposeAllResources()` が publication の `done()` を呼んでローカルの参照を残さない。
解放が既に完了していても session の close で stream は閉じているため、wire 上の後始末は済んでいる。

### エラーと認可

- 告知の確立失敗は `start()` の失敗にする。指定した機能を黙って落とさない
  (音声の `delivery` の検査と同じ方針)
- 確立後の stream エラー (RESET など) は `onError` に流し、配信は続ける
- `error` コールバックは確立前の `REQUEST_ERROR` でも呼ばれる。
  告知の確立前はコールバックの通知を抑止し、`start()` の失敗として 1 回だけ通知する (実装済み)
- SETUP に載せたトークン (`Session.setupAuthorizationToken`) を `publishNamespace` の
  `authorizationToken` に渡す。`setupAuthorizationTokenOptions()` を PUBLISH と共用する (実装済み)
- 高レベル API の `namespace` は 0 フィールドを許す。`PUBLISH_NAMESPACE` の 0 フィールド prefix は
  全 namespace に一致するため、`announceNamespace: true` かつ `namespace` が空配列なら `start()` を
  拒否する (黙って全 namespace を告知しない。実装済み)

### 代替案

- 高レベル API が制御プレーン用の session を別に張り、そこで告知する。
  会議の現状をライブラリ化した形だが、session が 2 本になりライフサイクルが複雑になる。
  配信の session と告知の session を relay が関連付けるかも実装依存になる
- 現状どおりアプリが低レベル API で制御プレーンを張る。高レベル API と告知の二重管理が残る
- `MediaPublisher` から内部の `Session` を公開し、アプリが `publishNamespace` を呼ぶ。
  解放の責務がアプリへ漏れ、`stop()` と `close()` のライフサイクルと一致しなくなるため採らない
- 同一 session で告知する (推奨)。セッションが 1 本で、開始と停止のライフサイクルが一致する

## 検討事項と決定

実装時に次のとおり決めた。既定値は `false` (opt-in)、告知失敗は `start()` の失敗、
`namespacePublication` は公開、告知は `PUBLISH` の後、オプション名は `announceNamespace` である。

1. 既定値を `false` (opt-in) にするか `true` にするか
   - `false`: 既存の呼び出しの挙動が変わらない。relay が `PUBLISH_NAMESPACE` を拒否する場合の影響も opt-in に限られる
   - `true`: 高レベル API の配信が既定で discovery に出る。relay の対応と失敗時の扱いを先に固定する必要がある
   - 推奨: 最初は `false`。実リレーで `announceNamespace: true` の E2E が通ってから既定を再検討する
2. 告知失敗を `start()` の失敗にするか、`onError` で通知して配信を続けるか
   - 推奨: `start()` の失敗
3. `namespacePublication` を公開するか、自動ライフサイクルだけにするか
   - 「ライフサイクル (`done`)」を API で表すなら公開する。告知だけを先に終えたい場合に要る
4. 告知を `PUBLISH` の前と後のどちらに置くか (推奨は後)
5. オプション名を `announce` にするか `announceNamespace` にするか
   - 低レベル API の `publishNamespace` に合わせるなら `announceNamespace`。依頼の例は `announce`。
     採用は `announceNamespace` である

## テスト計画

単体テスト (既存の接続境界の差し替えを使う。モジュール置換はしない)。

- `announceNamespace` を指定しない場合に `publishNamespace` を呼ばない
- `announceNamespace: true` で `namespace` と同じ配列、SETUP のトークン付きで 1 回呼ぶ
- PUBLISH が成功した後に告知する (単体テストは catalog の PUBLISH との順序を固定し、
  音声・映像の PUBLISH との順序は await の位置で保証する)
- 告知の `REQUEST_OK` 前に `close()` が重なった場合に `start()` が失敗し、リソースが残らない
  (`stop()` は start 中に呼べないため対象外)
- 告知の失敗で `start()` が失敗し、`onError` は 1 回だけ
- `stop()` と `close()` で `done()` が 1 回、再 `start()` で再度告知する
- `pause()` と `resume()` で `done()` も再告知もしない
- ピア起点の close で `done()` の失敗通知が起きない
- 確立後の stream エラーで `onError` が 1 回だけ (配信は継続)
- `namespacePublication` の参照 (start 前と実行中 null / publishing 中 active / stop 後 null)
- `namespace: []` と `announceNamespace: true` で `start()` が失敗する

E2E (実リレー)。2026-11-02 に実装後に確認し、
`tests/e2e/relay/namespace-announcement.spec.ts` を追加した (1 passed)。

- 前提: relay が `SUBSCRIBE_NAMESPACE` に対応していること。
  2026-10-03 の試行では応答が無かったが、2026-11-02 には往復できた
- `tests/e2e/main.ts` に `startPublishNamespace` / `startSubscribeNamespace` などの
  namespace 系の操作を露出する
- `announceNamespace: true` で `start()` し、`SUBSCRIBE_NAMESPACE` で `NAMESPACE` を受信する
- `close()` (ハーネスの `stopPublisher`) で `NAMESPACE_DONE` を受信する
- 発見した namespace のトラックを `SUBSCRIBE` して受信する経路は 2026-11-03 に
  実リレーで確認した (`tests/e2e/relay/namespace-discovery-subscribe.spec.ts`)
- relay が未対応ならテストを追加しない (失敗を隠さない)

ドキュメント。

- `docs/HIGH_LEVEL_API.md` のオプション、プロパティ、認可の付与先一覧、状態遷移
- `docs/ARCHITECTURE.md` の MediaPublisher 内部構成
- 実装後、この文書には採否と移行先を残す
- `CHANGES.md` は draft 期間中なので更新しない (`CODEBASE.md`)

## 過去の API 削除との関係

draft-17 期には `NamespaceAnnouncement` を含む namespace 系 API があったが、
peer 起点の request 受信の削除に伴い 2026-04-22 に削除された。
その後、低レベル API の namespace 系が再実装され、現行の `publishNamespace` と
`NamespacePublication` になった。実装前の高レベル API はこの API を使っていなかった。
今回の実装は削除前の API を戻すのではなく、現行の低レベル API を高レベル API の session で使う。

## 参照

- draft-ietf-moq-transport-23 §4.1 (Publishing Namespaces) / §4.2 (Subscribing to Namespaces) /
  §6.4.2.3 (Request Cancellation and Rejection) / §9.14 (PUBLISH_NAMESPACE) /
  §9.15 (SUBSCRIBE_NAMESPACE) / §9.16 (NAMESPACE) / §9.17 (NAMESPACE_DONE)
- draft-ietf-moq-msf-01 §11.4.3 (Presenting Authorization)
- `src/createMediaPublisher.ts` の `MediaPublisherImpl.start` / `createPublishers` / `disposeAllResources`
- `src/codec/types.ts` の `MediaPublisherOptions` / `MediaPublisher`
- `src/session.ts` の `Session.publishNamespace` / `Session.setupAuthorizationToken`
- `src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesCloseNamespacePublication`
- `src/session/publicTypes.ts` の `NamespacePublication` / `PublishNamespaceOptions`
- `src/session/namespaceLoops.ts` の PUBLISH_NAMESPACE stream の受信ループ
- `src/session/lifecycle.ts` の session 終了時の namespace publication の後始末
- 実リレーでの namespace discovery の試行結果 (2026-10-03)
