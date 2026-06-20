# SUBSCRIBE_TRACKS に対する PUBLISH メッセージ受信を実装する

- Priority: High
- Created: 2026-06-17
- Model: Opus 4.8
- Branch: feature/fix-subscribe-tracks-publish-reception
- Polished: 2026-06-20

## 目的

`Session.subscribeTracks()` 呼び出し後、サーバーから新規双方向ストリームで到着する `PUBLISH` メッセージを受信できない問題を修正する。`transport.incomingBidirectionalStreams` を監視するループが未実装のため、`SUBSCRIBE_TRACKS` リクエストに対する `PUBLISH` 応答がアプリケーションに届かない。

## 優先度根拠

`SUBSCRIBE_TRACKS` は Track Namespace Prefix にマッチする全 track を subscribe する MOQT 制御メッセージであり、対応する `PUBLISH` メッセージを受信できなければ subscriber 側は一切のデータを受け取れない。`subscribeTracks()` の呼び出し自体は成功し REQUEST_OK を正しく受信するが、後続の `PUBLISH` を受信する経路が存在しない。High とする。

## 現状

`src/session.ts` において:

- `subscribeTracks()` (L1737): SUBSCRIBE_TRACKS を送信し、同一ストリームの応答側で REQUEST_OK/REQUEST_ERROR を待つ。実装は完了している
- `startTracksStreamLoop()` (L2097): REQUEST_OK/REQUEST_ERROR/GOAWAY/PUBLISH_BLOCKED を処理する。実装は完了している。コメント (L2094-2095) で「PUBLISH メッセージは別の新規双方向ストリームで到着する」ことを認識している
- `initialize()` (L1244-1251): `startControlMessageLoop()` / `startIncomingStreamLoop()` (`transport.incomingUnidirectionalStreams`) / `startDatagramLoop()` を起動するが、`transport.incomingBidirectionalStreams` を監視するループは未実装
- `TracksSubscriptionCallbacks` (L593): `onPublishBlocked` / `error` / `goaway` の 3 コールバックのみ。PUBLISH 受信をアプリケーションに通知する `onPublish` コールバックが存在しない
- `BidiSessionInternal` (bidi.ts:96-127): `tracksSubscriptions` フィールドを含まない

`startTracksStreamLoop` は SUBSCRIBE_TRACKS 送信に使った双方向ストリームの**応答半分**を処理するループであり、サーバーが**新規に開く**双方向ストリーム（`transport.incomingBidirectionalStreams` 経由）の監視とは別物である。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§3.3.2 (Bidirectional Streams)**: 双方向ストリームは特定のメッセージタイプで開始されなければならない。それ以外のメッセージタイプで始まる双方向ストリームを受信した場合、エンドポイントは PROTOCOL_VIOLATION でセッションを閉じなければならない (MUST)
- **§10.19 (SUBSCRIBE_TRACKS)**: subscriber が Track Namespace Prefix を指定し、マッチする全 track を subscribe する。publisher は同一ストリームの応答半分で REQUEST_OK または REQUEST_ERROR を返し (MUST)、成功時は新規双方向ストリームで PUBLISH メッセージを送信する
- **§10.10 (PUBLISH)**: publisher が新規双方向ストリームの最初のメッセージとして PUBLISH を送信する
- **§5.1 (Subscribing to Tracks)**: subscriber は PUBLISH に応答して必ず 1 つの PUBLISH_OK または REQUEST_ERROR を送信しなければならない (MUST)。同一 track への重複 PUBLISH に対しては DUPLICATE_SUBSCRIPTION (0x19) の REQUEST_ERROR を返さなければならない (MUST)
- **§10.6.2 (REQUEST_ERROR Error Codes)**: DUPLICATE_SUBSCRIPTION = 0x19。エンドポイントが既に subscribe 済みの Track に対して重複して subscribe/publish リクエストを受信した場合に使用する
- **§10.4 (GOAWAY)**: リクエストストリーム上の GOAWAY は当該リクエストのマイグレーションを開始するために送られる (MAY)。制御ストリーム上の GOAWAY はセッション全体の graceful shutdown を開始する
- **§10.10 (PUBLISH)**: 受信したくない Track に対する PUBLISH を受信した subscriber は UNINTERESTED の REQUEST_ERROR を送信すべきである (SHOULD)

## 設計方針

### 概要

1. `TracksSubscriptionCallbacks` に `onPublish` コールバックを追加し、アプリケーションが PUBLISH 受信時にコールバックを提供できるようにする
2. `incomingBidirectionalStreams` 監視ループ (`startIncomingBidirectionalStreamLoop`) を新設する
3. `handleIncomingBidirectionalStream` で PUBLISH メッセージを受信・検証し、SubscriberImpl を生成する
4. 後続メッセージ読み取りループで PUBLISH_OK 送信・後続メッセージ処理を行う

### 1. `TracksSubscriptionCallbacks` に `onPublish` コールバックを追加する

```typescript
export interface TracksSubscriptionCallbacks {
  /**
   * サーバーから PUBLISH メッセージを受信したときに呼ばれる
   * draft-ietf-moq-transport-18 §10.19 / §10.10
   *
   * @param namespaceSuffix - Track Namespace Prefix を除いた Suffix。PUBLISH の
   *   trackNamespace タプルから、マッチした namespacePrefix の要素数分を先頭除去した残り
   * @param trackName - PUBLISH に含まれる Track Name
   * @returns SubscribeCallbacks — 内部的に SubscriberImpl を生成しコールバックを伝搬する。
   *   拒否する場合は SubscribeCallbacks に加えて REQUEST_ERROR を送信することで
   *   UNINTERESTED を表現する（戻り値では表現しない）
   */
  onPublish?: (
    namespaceSuffix: string[],
    trackName: string,
  ) => SubscribeCallbacks | Promise<SubscribeCallbacks>;

  // 以下既存:
  onPublishBlocked?: (namespaceSuffix: string[], trackName: string) => void;
  error?: (error: Error) => void;
  goaway?: (newSessionUri: string) => void;
}
```

戻り値の `SubscribeCallbacks` は、内部的に生成する `SubscriberImpl` のコールバック (`object` / `datagram` / `end` / `error` / `goaway`) として使われる。通常の `subscribe()` と同様のライフサイクル管理を行う。

### 2. `incomingBidirectionalStreams` 監視ループを新設する

`initialize()` 内で `startIncomingBidirectionalStreamLoop()` を呼び出し、`transport.incomingBidirectionalStreams` から新規双方向ストリームを読み取るループを開始する。reader は `incomingBidiStreamReader` として class field に保持し、`close()` で `reader.cancel()` + `reader.releaseLock()` する。

ループのエラーハンドリングは `startIncomingStreamLoop` / `startDatagramLoop` と同様に `notifyErrorIfActive` で行う。

### 3. PUBLISH メッセージの受信処理

`handleIncomingBidirectionalStream()` の処理手順:

1. 双方向ストリームの読み取り可能側から `ControlStreamReader` で最初のメッセージを読み取る（`bidiReadResponseFromBidiStream` のパターンを流用）
2. 最初のメッセージが `MessageType.PUBLISH` であることを検証する。PUBLISH 以外の場合は §3.3.2 に基づき PROTOCOL_VIOLATION でセッションを閉じる
3. `decodePublishPayload` でデコードする。デコード失敗時は PROTOCOL_VIOLATION でセッションを閉じる。デコード成功時は `emitDebug("recv", MessageType.PUBLISH, payload, decoded)` でデバッグ出力する
4. デコードした PUBLISH の `trackNamespace` が、アクティブな `tracksSubscriptions` のいずれかの `namespacePrefix` に前方一致するか検証する
5. マッチした `tracksSubscription` の `callbacks.onPublish?.(namespaceSuffix, trackName)` を呼び、`SubscribeCallbacks` を取得する
6. 取得した `SubscribeCallbacks` を用いて `SubscriberImpl` を生成し:
   - `subscribers.set(requestId, impl)` と `subscribersByAlias.set(trackAlias, impl)` に登録する
   - `impl.goawayCallback = subscribeCallbacks.goaway` を設定する
   - PUBLISH が到着した双方向ストリームを `requestStreams` に登録し、後続の `onUnsubscribe` / `onUpdate` が `bidiCancelSubscription` / `bidiSendRequestUpdate` 経由でストリームにアクセスできるようにする
   - `this.pendingSubgroupBuffer.notifyAlias(trackAlias, "subscriber")` を呼び、SubscriberImpl 登録より先に到着した subgroup データストリームを subscriber mode に合流させる
7. PUBLISH に対して §5.1 の MUST に基づき **PUBLISH_OK を送信する**。`encodeRequestOkPayload({ trackProperties: [] })` でペイロードを構築し、双方向ストリームの書き込み側に `writer.write()` する
8. PUBLISH_OK 送信後、同一の双方向ストリーム上で後続メッセージを読み取るサブループを開始する。処理対象: PUBLISH_DONE / GOAWAY / REQUEST_OK（REQUEST_UPDATE への応答）/ REQUEST_ERROR。未知メッセージタイプは PROTOCOL_VIOLATION
9. サブループのエラーハンドリング: `ProtocolViolationError` → `closeWithError(PROTOCOL_VIOLATION)`、セッション終了起源エラー → 無視、その他 → subscriber の error コールバック呼び出し
10. サブループ終了時（finally）に `requestStreams.delete(requestId)` を実行する

生成する `SubscriberImpl` には以下を設定する:
- subscriber の `requestId` キーとして、PUBLISH に含まれるサーバー発行の `requestId`（odd パリティ）をそのまま用いる。これはクライアント発行の requestId（even パリティ）と ID 空間が異なるため衝突しない
- `onUnsubscribe`: `bidiCancelSubscription(session, requestId)` を呼び、STOP_SENDING 送信とストリームリソース解放を行う（要 `requestStreams` 登録）
- `onUpdate`: `bidiSendRequestUpdate(session, targetRequestId, options)` を呼び、同ストリームに REQUEST_UPDATE を送信する（要 `requestStreams` 登録）

### 4. namespace マッチングロジック

`trackNamespace` が `namespacePrefix` に前方一致するかで判定する。一致条件: `trackNamespace.tuple` の先頭から `namespacePrefix.length` 個の要素が `namespacePrefix` と完全一致する。

`namespaceSuffix` の計算: `trackNamespace.tuple.slice(namespacePrefix.length)`。これが PUBLISH_BLOCKED の `trackNamespaceSuffix` と同一の計算方式である。

どの `tracksSubscriptions` にもマッチしない PUBLISH は、仕様上「受信したくない PUBLISH」に該当するため、§10.10 の SHOULD に基づき UNINTERESTED の REQUEST_ERROR を送信しストリームを閉じる。セッションは閉じない。

### 5. エッジケース

- `tracksSubscription` が `unsubscribe()` または `close()` された後（state が "closed"）に PUBLISH が到着した場合: ストリームをキャンセルし無視する
- 同一 track に対する重複 PUBLISH: `subscribersByAlias` に既にエントリがある場合、§5.1 の MUST に基づき **DUPLICATE_SUBSCRIPTION (0x19) の REQUEST_ERROR** を送信しストリームを閉じる。セッションは閉じない
- PUBLISH デコード失敗時: PROTOCOL_VIOLATION でセッションを閉じる
- セッションが既に閉じている状態で PUBLISH bidi ストリームが到着した場合: ストリームをキャンセルし無視する
- `onPublish` コールバックが設定されていない場合: `onPublish` は optional であり、指定されていない場合は SubscriberImpl を生成せず、空の object callback `() => {}` を渡した SubscriberImpl を生成する（データ受信は行うがアプリケーション通知はしない）。または onPublish 未設定 = 当該 track に関心なしとして UNINTERESTED の REQUEST_ERROR を送信する。前者をデフォルトとする（track データのドロップによる再送負荷を避けるため）
- `onPublish` が例外をスローまたは Promise reject した場合: SubscriberImpl 生成前であればストリームをキャンセルし、生成後であれば SubscriberImpl の error コールバックに渡す。セッションは閉じない（アプリケーションのエラーはプロトコル違反ではない）
- REQUEST_OK より先に PUBLISH 用双方向ストリームが到着した場合: 現状の `subscribeTracks()` は `tracksSubscriptions` エントリの state を REQUEST_OK 受信前に `"active"` に設定している (L1797) ため、マッチング自体は可能。ただし REQUEST_OK が後続で到着した場合の処理（重複 REQUEST_OK 検出）に注意が必要。本 issue のスコープ内で対応する

## 変更対象ファイル

- `src/session.ts`:
  - `TracksSubscriptionCallbacks` に `onPublish` コールバックを追加する
  - `startIncomingBidirectionalStreamLoop()` を新設する。reader を `incomingBidiStreamReader` として class field に保持する
  - `handleIncomingBidirectionalStream()` を新設する
  - `initialize()` で `startIncomingBidirectionalStreamLoop()` を呼び出す
  - `close()` で `incomingBidiStreamReader` をキャンセル・解放する（既存の cleanup の最後、transport.close() の前で行う）
- `src/session/bidi.ts`:
  - `BidiSessionInternal` に `tracksSubscriptions` フィールドを追加する。型は `Map<bigint, { callbacks: TracksSubscriptionCallbacks; state: "active" | "closed"; namespacePrefix: string[]; ... }>` で、`session.ts` の Map 値型と一致させる
  - `handleIncomingBidirectionalStream` は `session.ts` 側に実装する（`bidi.ts` への抽出は不要。ただし #0302 で namespaceLoops.ts 等に再抽出される可能性がある）
- `src/message/publish.ts`: `decodePublishPayload` のコメント「リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。」を削除する（本実装によりクライアントでもランタイム使用される）
- `CHANGES.md` に `[FIX]` エントリを追記する

## テスト方針

- `session.prop.ts` の既存テストが変更なしで PASS することを必須とする
- 新規に追加するテスト:
  - namespace 前方一致マッチングロジックの純粋関数化と単体テスト（`trackNamespace` タプルと `namespacePrefix` 配列の前方一致判定、`namespaceSuffix` 計算）
  - `decodePublishPayload` のラウンドトリップテスト（既存 PBT があるがランタイム使用に備え確認）
  - `onPublish` コールバックが `undefined` の場合のデフォルト動作検証
  - 重複 PUBLISH に対する DUPLICATE_SUBSCRIPTION エラー応答の検証
  - マッチしない PUBLISH に対する UNINTERESTED REQUEST_ERROR 応答の検証
  - 未知メッセージタイプ到着時の PROTOCOL_VIOLATION 検証
- 非同期ストリームループのテストはモック禁止の制約により WebTransport 接続が必要なため、既存の `session.prop.ts` PBT と `session/bidi.test.ts` のパターンに従い、同期処理可能な純粋関数部分を優先的にテストする

## 完了条件

- `initialize()` が `startIncomingBidirectionalStreamLoop()` を呼び出す
- サーバーから到着した新規双方向ストリーム上の PUBLISH メッセージが `decodePublishPayload` で正しくデコードされる
- デコードされた PUBLISH の `trackNamespace` がアクティブな `tracksSubscriptions` の `namespacePrefix` と正しくマッチングされる
- マッチした PUBLISH に対して `callbacks.onPublish?.(suffix, trackName)` が呼ばれ、返された `SubscribeCallbacks` を用いて `SubscriberImpl` が生成・登録される
- 重複 PUBLISH に対して DUPLICATE_SUBSCRIPTION (0x19) の REQUEST_ERROR が送信される
- PUBLISH_OK が §5.1 の MUST に従って送信される
- `pendingSubgroupBuffer.notifyAlias()` が呼ばれ、SubscriberImpl 登録前に到着した subgroup データストリームが正しく合流する
- `requestStreams` に登録されたストリーム情報により `unsubscribe` / `requestUpdate` が正しく動作する
- 後続の単方向データストリームが `subscribersByAlias` 経由で正しく配送される
- `close()` で `incomingBidiStreamReader` が解放される
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリが追記される
