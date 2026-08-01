# Object / Track Properties への GREASE 送信

- Created: 2026-07-31
- Completed: 2026-08-01
- Branch: feature/add-grease-properties
- Polished: 2026-08-01

## 目的

draft-ietf-moq-transport-19 §14 (Grease) に基づき、Object Properties と Track Properties に GREASE Property を opt-in で送信する機能を実装する。

SETUP Option への GREASE 送信（`0037-add-grease-sending.md`、#117 マージ済み）の後続 issue である。SETUP はセッション開始時に 1 回だけ送信されるのに対し、Properties は送信頻度が高いため、相互接続検証の効果が高い。SETUP 側の実装（`ConnectOptions.grease` と `generateGreaseSetupOptionType()`）を踏まえ、同じ opt-in 機構を Properties 送信パスへ拡張する。

## 現状

- `src/grease.ts` に `isGreaseValue()` / `generateGreaseValue()` があるが、Properties の送信パスからの参照はない（参照元は SETUP の `src/message/setup.ts` のみ）。
- Track Properties の組み立ては `src/session/params.ts` の `buildPublishTrackProperties()` が担当し、concrete な `TrackPropertyId` のみで GREASE Property を挿入しない。`src/properties.ts` はエンコード / デコード / 検証のモジュールである。
- Object Properties の送信パス（`src/session/publish.ts` の `publishSendObjectInternal()` / `publishSendDatagram()`）も、呼び出し元から渡された `properties` バイト列に delivery timeout を合成する（`mergeDeliveryTimeoutObjectProperties()`）だけで、自動 GREASE 注入はしない。
- 受信側は、送信側が Mandatory Track Property 範囲（0x4000-0x7FFF）を避ける限り修正不要である。Object Properties 受信は未知のプロパティ ID を生バイトとして通過させる（`src/dataStream.ts` の `decodeObjectFields()` はバイト列の slice のみ。プロパティ単位のパースは `src/properties.ts` の `readDeliveryTimeoutObjectProperties()` が担当し未知 ID を無視する）。Track Properties 受信は `src/properties.ts` の `decodeProperties()` / `parseProperties()` が未知 Property を `unknownProperties` として保持するが、Mandatory Track Property 範囲 0x4000-0x7FFF の未知 ID は §2.5.1 に従い `MalformedTrackError` で拒否する（仕様準拠の正しい挙動）。

## 設計方針

draft-ietf-moq-transport-19 §14 の GREASE 値は `0x7f * N + 0x9D`（N は非負整数）のパターンに従う。Properties は §15.8 の GREASE 予約レジストリに含まれ、§14 は "Unknown Properties MUST be handled as specified in Section 2.5" と定める。

opt-in 機構は SETUP 側（0037）と統一する。

- `src/session.ts` の `ConnectOptions.grease?: boolean`（0037 で追加済み）を再利用する。`grease: true` のとき、SETUP（実装済み）に加え、Track Properties と Object Properties にも GREASE Property を 1 つずつ注入する。既定は `false`（注入しない）。
- 送信頻度が高いパスだが、既定が off のため性能影響は opt-in 時に限られる。SETUP と同じく、opt-in 時は確率制御せず常時 1 つ注入する。

GREASE Property の Property ID と値:

- Property ID は `generateGreaseValue(n)` で生成する。N は **偶数** に固定して Property ID を奇数にする（`0x9D` は奇数、`0x7f * 偶数` は偶数、合計は奇数）。Properties は §2.5 / §11.2.1.2 の Key-Value-Pairs（Figure 2）に従い、奇数 ID は Length プレフィックス付きバイト列、偶数 ID は varint 値としてエンコードされるため、N を偶数に固定して奇数 ID にすることで任意のバイト列を安全に送信できる（SETUP と同じ判断）。値は SETUP と同じく空バイト列とする。
- N は GREASE 値が Mandatory Track Property 範囲 **0x4000-0x7FFF に落入しない** よう選ぶ。§2.5.1 により、Track Properties で理解できない Mandatory Track Property を受信した endpoint はその track を処理・転送してはならず（REQUEST_ERROR UNSUPPORTED_EXTENSION）、Object Property として Mandatory Track Property を受信した Object は malformed になる。`0x7f * N + 0x9D` は N ∈ [128, 256] で 0x4000-0x7FFF に落入するため（例: N=128 → 0x401D、N=256 → 0x7F9D）、この範囲を除外する。具体的には N を [0, 126] の偶数から選ぶ（GREASE 値は 0x9D 〜 0x3F1F で 0x4000 未満、奇数 ID。delta / varint のオーバーヘッドも小さい）。
- `generateGreaseValue()` は `bigint` を返す。Properties の `Property.id` は `bigint` 型のため、SETUP のような `Number()` 変換の精度制約は不要だが、N の範囲は上記の通り 0x4000 未満に収める。

Track Properties への注入:

- `src/session/params.ts` の `buildPublishTrackProperties()` が、`grease: true` のとき GREASE Property（奇数 ID + 空バイト列）を `Property[]` に 1 つ追加する。`grease` フラグは `ConnectOptions` からセッション内部（publish 経路が参照できる状態）へ受け渡す。
- `src/properties.ts` の `encodeProperties()` は delta encoding のため ID を昇順ソートするが、GREASE Property も他 Property と同様にソート対象となるだけでエンコードは壊れない（SETUP の `encodeSetupPayload()` と同じ）。
- ランタイムで Track Properties を送信するのは PUBLISH のみである（`src/session.ts` が `buildPublishTrackProperties()` の結果を `encodePublishPayload()` で送信する）。PUBLISH_OK / REQUEST_UPDATE_OK 等の REQUEST_OK 系メッセージは §5.1 により Track Properties を空にしなければならず（違反は PROTOCOL_VIOLATION、`src/session/bidi.ts` の `validateRequestOkNoTrackProperties()` が検証）、GREASE 注入対象外である。SUBSCRIBE_OK / FETCH_OK の Track Properties エンコード（`src/message/subscribe.ts` / `fetch.ts`）はリレーサーバー実装用でランタイムでは使用しない。

Object Properties への注入:

- `src/session/publish.ts` の `publishSendObjectInternal()` / `publishSendDatagram()` が、`grease: true` のとき GREASE Property を Object Properties バイト列に追加する。送信する各オブジェクト（subgroup ストリーム / datagram）に 1 つ注入する。
- Object Properties は §11.2.1.2 で "length in bytes followed by Key-Value-Pairs (see Figure 2)" と定義される。注入は既存の Object Properties helper（`src/properties.ts` の `mergeDeliveryTimeoutObjectProperties()`）と同じ規約（Type + Length + Value）に従い、奇数 ID の GREASE Property を Length プレフィックス付きバイト列として追加する。
- Object Properties の有無は Datagram / Subgroup ヘッダーの Type（Properties Present フラグ）に反映されるため、元々 properties がないオブジェクトへ注入する場合はヘッダー Type と整合させる。

## 影響範囲

- `src/session/params.ts`（`buildPublishTrackProperties()` への GREASE Property 追加、`grease` フラグの受け渡し）
- `src/session/publish.ts`（`publishSendObjectInternal()` / `publishSendDatagram()` への GREASE Object Property 注入）
- `src/session.ts` / `src/index.ts`（`ConnectOptions.grease` は 0037 で追加済み。Properties 送信パスへの受け渡し）
- `src/properties.ts`（GREASE Property 組み立て helper の追加。必要に応じて）
- テスト（`shiguredo-typescript` の役割分担に従い、ラウンドトリップ等は PBT、opt-in / 既定挙動 / N 範囲の不変条件は単体テストで検証）

## 完了条件

- opt-in（`ConnectOptions.grease: true`）指定時に Track Properties（PUBLISH 送信）/ Object Properties へ GREASE Property が 1 つ含まれる。
- GREASE Property の ID は `isGreaseValue()` が `true` を返し、かつ Mandatory Track Property 範囲 0x4000-0x7FFF に落入しない。
- 既定挙動（`grease` なし）が変わらない。
- GREASE Property を含む Track Properties / Object Properties がエンコード・デコードでラウンドトリップする。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §14 (Grease)
- draft-ietf-moq-transport-19 §2.5 (Properties) / §2.5.1 (Mandatory Track Properties)
- draft-ietf-moq-transport-19 §15.8 (MOQ Properties)
- draft-ietf-moq-transport-19 §11.2.1.2 (Object Properties) / §12 (MOQT Properties)
- RFC 9170 §3.3 (GREASE 送信の SHOULD 推奨)

## 解決方法

`ConnectOptions.grease`（0037 で追加済み）を再利用し、Track Properties と Object Properties に GREASE Property の opt-in 注入を実装した。

- `src/properties.ts`: `generateGreaseProperty()`（N を [0, 126] の偶数から選び 0x7f * N + 0x9D の奇数 ID + 空バイト列の Property を生成。Mandatory Track Property 範囲 0x4000-0x7FFF を避ける）と `appendGreaseObjectProperty()`（Object Properties バイト列に GREASE を Type + Length + Value で末尾追加）を追加。
- `src/session/params.ts`: `buildPublishTrackProperties()` に `grease` 引数を追加し、`true` で GREASE Property を 1 つ追加。
- `src/session.ts` / `src/session/types.ts`: `SessionImpl` に `grease` フィールドを追加し、`initialize()` で `ConnectOptions.grease` を受け渡す。PUBLISH 送信で `buildPublishTrackProperties(options, this.grease)`。
- `src/session/publish.ts`: `publishSendObjectInternal()` が status Normal かつ grease 有効時に各オブジェクトへ GREASE Object Property を注入。`publishSendDatagram()` が grease 有効時に hasProperties 判定前に注入し Datagram Type の Properties Present ビットを整合。
- テスト: `src/properties.test.ts`（generateGreaseProperty 不変条件 / appendGreaseObjectProperty / Track Properties roundtrip / parseProperties 保持）、`src/session/params.test.ts`（grease opt-in / 既定不変）、`src/dataStream.datagram.test.ts`（GREASE Object Properties の EXT 型 roundtrip）を追加。
- `CHANGES.md`: `## develop` に `[ADD]` を追記。

 Object Properties のエンコードは既存 helper（`mergeDeliveryTimeoutObjectProperties`）と同じ absolute TLV 規約に従う。仕様の delta encoding（§11.2.1.2 / Figure 2）との乖離は既存のもので、本 issue の対象外（別 issue で対応予定）。
