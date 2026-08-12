# TRACK_NAMESPACE_PREFIX による namespace サブスクリプション更新 API がない

- Priority: Medium
- Created: 2026-08-06
- Completed: 2026-08-12
- Model: DeepSeek V4 Flash
- Branch: feature/add-moqt-draft-19-track-namespace-prefix-update-api
- Polished: 2026-08-08

## 目的

draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions) で定義される TRACK_NAMESPACE_PREFIX パラメータ (0x34) による SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の prefix 更新 API を追加する。現在はエンコード / デコードのみ実装されており、ユーザーが利用できる API が存在しない。

## 優先度根拠

§10.9.2 は「A subscriber can update the Track Namespace Prefix of an established SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS by including the TRACK_NAMESPACE_PREFIX parameter in a REQUEST_UPDATE.」を定める。codec は実装済みだが API 未接続のため、仕様の機能が利用できない。Medium。

## 現状

- `encodeParameterTrackNamespace` / `getParameterTrackNamespace` (`src/message/parameter.ts`) が実装・公開されている (`src/message/index.ts` で re-export)。
- `MessageParameterType.TRACK_NAMESPACE_PREFIX` (0x34) が `REQUEST_UPDATE_ALLOWED_PARAMS` (`src/message/parameterScope.ts`) に含まれており、受信側のスコープ検証は許可済み。
- しかし更新 API は存在しない:
  - `NamespaceSubscription` / `TracksSubscription` (`src/session.ts`) は `state` と `unsubscribe()` のみで、`update()` を持たない (track 系の `SubscriberImpl` だけが `update()` を持つ)。
  - `RequestUpdateOptions` (`src/subscriber.ts`) に `trackNamespacePrefix` フィールドがない。
  - `bidiSendRequestUpdate` (`src/session/bidi.ts`) は `SubscriberImpl` を引数に取り、`session.requestStreams` から stream を引くため、namespace / tracks サブスクリプションには接続できない。
  - `subscribeNamespace()` / `subscribeTracks()` (`src/session.ts`) は受け取った `namespacePrefix` を `namespaceSubscriptions` / `tracksSubscriptions` に保持するだけで、更新の手段を持たない。
- 変更対象ファイル: `src/session.ts` (`NamespaceSubscription` / `TracksSubscription` への update 追加、`subscribeNamespace` / `subscribeTracks`)、`src/session/bidi.ts` (namespace 用の REQUEST_UPDATE 送信 free function)、`src/session/namespaceLoops.ts` (REQUEST_UPDATE_OK / REQUEST_ERROR 応答処理)、`src/session/params.ts` (双方向 prefix 判定の純関数)、`src/session/bidi.test.ts` / `src/session/namespaceLoops.test.ts` (新規作成。テスト追加)、`CHANGES.md`。

## 設計方針

- **API 形状**: 確立済みサブスクリプションへの更新 (§10.9.2 の「an established SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS」) であるため、`NamespaceSubscription` / `TracksSubscription` に `update(options?: NamespaceUpdateOptions): Promise<void>` を追加する (既存の `SubscriberImpl.update()` と同型)。`subscribeNamespace()` / `subscribeTracks()` の呼び出しオプションには追加しない (それは新規購読時の設定であり、REQUEST_UPDATE は確立後の操作のため)。`NamespaceUpdateOptions` (例: `{ trackNamespacePrefix: string[] }`) を新設する (`RequestUpdateOptions` に `trackNamespacePrefix` を追加する方式は、track 系 `SubscriberImpl.update()` からの誤送信を `REQUEST_UPDATE_ALLOWED_PARAMS` のスコープ検証では検出できないため不採用とする)。
- **REQUEST_UPDATE 送信**: namespace / tracks 用の REQUEST_UPDATE 送信を `bidiSendRequestUpdate` に足すのではなく、`SubscriberImpl` 非依存の free function (例: `bidiSendNamespaceRequestUpdate(session, requestId, streamWriter, options)`) として `src/session/bidi.ts` に追加する。`namespaceSubscriptions` / `tracksSubscriptions` が保持する `writer` を経由して送信し、`pendingRequestUpdate` に登録して応答を待つ。`MAX_REQUEST_UPDATES` ガード (`bidiSendRequestUpdate` と同様) を適用する。AUTHORIZATION_TOKEN の再付与 (§11.4.3 の track 関連トークン MUST 付与) は、`subscribeNamespace` / `subscribeTracks` の状態がトークンを保持しないため、本 issue では再付与しないことを明記する (トークン保持の追加は別 issue の対応とする)。
- **受信ループの改修 (必須)**: `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` (`src/session/namespaceLoops.ts`) は確立後の REQUEST_OK を「received second REQUEST_OK」として PROTOCOL_VIOLATION でセッションを閉じるため、そのままでは REQUEST_UPDATE の応答 (REQUEST_OK / REQUEST_ERROR) でセッションが切断される。ループを改修し、確立後 (`resolved === true`) の REQUEST_OK / REQUEST_ERROR を `pendingRequestUpdate` の解決 / reject に接続する。初期 REQUEST_OK (確立応答) と更新応答の区別は `resolved` フラグで行う。送信側 API だけを実装してもこの改修なしでは完了条件を満たせない。
- **新 prefix のデータフロー**: `pendingRequestUpdate` のエントリは現状 `resolve` / `reject` / `targetRequestId` のみで新 prefix の値を保持しないため、REQUEST_OK 受信時にループ側が新 prefix を知る経路がない。更新対象のサブスクリプションの状態 (例: `namespaceSubscriptions` / `tracksSubscriptions` の該当エントリに `pendingPrefix?: string[]` を追加) に新 prefix を保持し、REQUEST_OK 受信時にそれを `namespacePrefix` へ反映して `pendingPrefix` をクリアする方式を採る。REQUEST_ERROR 受信時は `pendingPrefix` をクリアして反映しない。
- **縮退・失敗時処理**: §10.9 の「When a REQUEST_UPDATE fails for a SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS or PUBLISH_NAMESPACE, the responder MUST close the bidi stream」に従い、失敗時はピアがストリームを閉じる。ループは `done` 検出時に `pendingRequestUpdate` を reject する (ストリームクローズによる暗黙の失敗をアプリへ通知)。REQUEST_ERROR (PREFIX_OVERLAP 等) 受信時も `pendingRequestUpdate` を reject し、成功時 (REQUEST_OK) のみ prefix を状態に反映する。更新応答の REQUEST_OK は `REQUEST_UPDATE_OK_ALLOWED_PARAMS` (`src/message/parameterScope.ts`) でスコープ検証する (初期 REQUEST_OK が `NAMESPACE_OK_ALLOWED_PARAMS` を使うのとは区別する)。
- **overlap 制約の送信前検証**: §10.9.2 の「The overlap restriction applies independently per type: the new prefix MUST NOT share a common prefix with any other active SUBSCRIBE_NAMESPACE (for a SUBSCRIBE_NAMESPACE update) or SUBSCRIBE_TRACKS (for a SUBSCRIBE_TRACKS update) in the same session.」に従い、**同一型のアクティブなサブスクリプションのみ** を対象に共通 prefix チェックを送信前に行う (型をまたぐチェックはしない)。仕様の「any **other** active」に従い、**更新対象のサブスクリプション自身は比較対象から除外する** (prefix 拡大更新を許可するため)。判定は「新 prefix が既存 prefix の sub-prefix」と「既存 prefix が新 prefix の sub-prefix」の双方向を確認する (片方向の `matchNamespacePrefix` の流用では不足するため、双方向判定の純関数を `src/session/params.ts` に追加する)。送信前検証は client 側の先行担保であり、仕様の MUST は受信側の PREFIX_OVERLAP 応答 (§10.2.19) である点を明記する。検証失敗時は throw する。
- **状態管理への反映**: REQUEST_OK 受信後のみ、`namespaceSubscriptions` / `tracksSubscriptions` の該当エントリの `namespacePrefix` を新 prefix に更新する。`tracksSubscriptions` の `namespacePrefix` は `matchPublishToSubscription` の PUBLISH マッチングに使用されるため、更新しないと新 prefix 配下の PUBLISH がマッチしなくなる。SUBSCRIBE_NAMESPACE 側は NAMESPACE / NAMESPACE_DONE の suffix がピアから相対値で届くためクライアント側の解決は発生しないが、将来の参照に備えて `namespacePrefix` も更新する。prefix 更新時は `startNamespaceStreamLoop` の `seenNamespaceSuffixes` (NAMESPACE_DONE の重複検証用 Set) をリセットする (旧 prefix 基準の stale key が新 prefix 基準の NAMESPACE_DONE を誤って検証通過させないため)。
- **§10.9.2 の SUBSCRIBE_TRACKS 固有の注意**: 「Updating the prefix of a SUBSCRIBE_TRACKS has no effect on existing subscriptions.」に従い、prefix 更新は既存の確立済み SubscriberImpl には影響しない (既存購読はそのまま維持される)。
- **テスト**: `NamespaceUpdateOptions` の送信バイト列 (TRACK_NAMESPACE_PREFIX 0x34 が REQUEST_UPDATE に載ること) のワイヤ検証、overlap 検証の単体テスト、`namespaceSubscriptions` / `tracksSubscriptions` の `namespacePrefix` 更新の検証を追加する。受信ループの REQUEST_UPDATE_OK / REQUEST_ERROR 応答処理は 0370 方式の実 W3C ストリーム注入で検証する。e2e は `TEST_MOQT_URI` 依存で常時実行されないため対象外。
- **ピアからの REQUEST_UPDATE (TRACK_NAMESPACE_PREFIX) 受信**: moqt-js はクライアント実装であり、受信 bidi ストリームの先頭は PUBLISH のみ許可 (`handleIncomingBidirectionalStream`) のため、SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の受信処理が存在しない。したがって受信側の PREFIX_OVERLAP 応答は本 issue のスコープ外とする (送信側 API の追加のみ)。
- **closed issue 0229 との関係**: 0229 (TRACK_NAMESPACE_PREFIX パラメータ追加) が「送信パスの実装 (namespace prefix の動的更新 API) は将来必要になった時点で別 issue として対応する」と先送りした。本 issue はその follow-up である。

## 完了条件

- `NamespaceSubscription` / `TracksSubscription` に `update()` が追加され、REQUEST_UPDATE で TRACK_NAMESPACE_PREFIX を送信して prefix を更新できること。
- 更新成功 (REQUEST_OK) 後の `namespaceSubscriptions` / `tracksSubscriptions` の `namespacePrefix` が新 prefix に更新され、SUBSCRIBE_TRACKS では新 prefix 配下の PUBLISH が `matchPublishToSubscription` でマッチすること。
- ピアの MAX_REQUEST_UPDATES を超える更新は throw すること。
- 同一型のアクティブなサブスクリプション (更新対象自身を除く) と共通 prefix を持つ更新は送信前に throw すること (per-type 独立。prefix 拡大更新は許可される)。
- REQUEST_ERROR (PREFIX_OVERLAP 等) 受信時は `update()` の Promise が reject され、prefix は更新されないこと。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE / MUST respond / 失敗時のストリームクローズ)
- draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions / per-type 独立 overlap 制約 / suffix は更新後 prefix 基準 / SUBSCRIBE_TRACKS は既存購読に影響しない)
- draft-ietf-moq-transport-19 §10.2.19 (TRACK_NAMESPACE_PREFIX Parameter / PREFIX_OVERLAP 応答の受信側 MUST)
- 関連: `issues/closed/0229-draft-18-add-track-namespace-prefix-parameter.md`（パラメータ追加。更新 API を先送りした元）

## 解決方法

- `NamespaceSubscription` / `TracksSubscription` に `update(options: NamespaceUpdateOptions)` を追加し、`SessionImpl.sendNamespaceRequestUpdate` 経由で `bidiSendNamespaceRequestUpdate` (`src/session/bidi.ts`) により REQUEST_UPDATE + TRACK_NAMESPACE_PREFIX (0x34) を送信する
- `src/session/namespaceLoops.ts` の受信ループを改修し、確立後の REQUEST_OK を REQUEST_UPDATE_OK としてスコープ検証 (REQUEST_UPDATE_OK_ALLOWED_PARAMS) 後に pending を解決して `namespacePrefix` へ反映、REQUEST_ERROR / ストリームクローズ (FIN / RESET) / セッションクローズ検証失敗時は pending を reject して反映しない
- §10.9.2 の per-type 独立 overlap 制約を `src/session/params.ts` の `namespacePrefixesOverlap` / `validateNamespacePrefixUpdate` で送信前に検証し、同一型のアクティブなサブスクリプション (更新対象自身を除く) と共通 prefix を持つ更新は throw する
- 更新反映は単一スロット `pendingPrefix` で管理するため、in-flight (REQUEST_OK 未受信) 中の 2 件目は throw する (並行更新の誤反映防止)
- テスト: `src/session/params.test.ts` (overlap 純関数)、`src/session/bidi.test.ts` (送信ワイヤ / ガード群 / 掃除)、`src/session/namespaceLoops.test.ts` を新規作成 (受信ループの REQUEST_OK / REQUEST_ERROR / ストリームクローズ / GOAWAY / RESET 応答処理)
- `CHANGES.md` の `## develop` に [ADD] を追記
