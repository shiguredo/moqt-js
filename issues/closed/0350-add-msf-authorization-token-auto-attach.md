# MSF の Authorization Token 自動付与を実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: 2026-07-31
- Model: Composer
- Branch: feature/add-msf-authorization-token-auto-attach
- Polished: 2026-07-27

## 目的

draft-ietf-moq-msf-01 §5.2.42 `authInfo` / §11.4.3 では、catalog が認可を要求する場合に SUBSCRIBE / FETCH 等へ Authorization Token を付与する必要がある。現状は catalog 型と検証のみで、高レベル API が `authInfo` を見てトークンを自動付与しない。

注: §5.2.37 `token` は **publish 側**（publishTracks への publish 認可）であり、subscribe 認可のシグナルは §5.2.42 `authInfo` である。本 issue は subscriber 側の自動付与を対象とする。

## 優先度根拠

認可付き配信ではトークン欠落で REQUEST_ERROR になり再生できない（§11.4.4 "Handling Authorization Failures"）。一方、認可なしカタログでは不要。媒体一般のブロッカーではないため Medium。

## 現状

- `CatalogTrack.authInfo` / `token` / `connectionUri` は型・MUST 検証済み (`src/msf.ts`)
- `createMediaPublisher` / `createMediaSubscriber` の `authorizationToken` は **接続オプション** として SETUP に載せる用途 (`src/createMediaSubscriber.ts:374-375` 付近)
- catalog の `authInfo` を読んでトラック subscribe 時に AUTHORIZATION_TOKEN パラメータを付与する経路は無い
- `SubscribeOptions` (`src/session.ts:405-510`) / `FetchOptions` (`src/session.ts:561-`) に `authorizationToken` フィールドは **無い**
- `buildSubscribeParameters` (`src/session/params.ts:163-250`) / `buildFetchParameters` は AUTHORIZATION_TOKEN を **一切送出しない**
- wire 層のみ存在: `MessageParameterType.AUTHORIZATION_TOKEN=0x03` (`src/message/types.ts:140`)、encoding `"length-prefixed"` (`src/message/parameter.ts:598`)、scope 許可 (`src/message/parameterScope.ts:21,104`)
- `#0316` 範囲外: 「§11.4.3 Authorization Token の SUBSCRIBE / SUBSCRIBE_NAMESPACE / FETCH / REQUEST_UPDATE / PUBLISH / PUBLISH_NAMESPACE への MUST 自動付与」

## 設計方針

1. catalog 受信後、対象 track に `authInfo` がある場合のトークン取得・付与フローを設計する
2. §11.4.3 の自動付与はスキーム非依存（AUTHORIZATION_TOKEN パラメータがトークンを運ぶだけ）。スキーム依存のトークン取得 (§11.4.2, "out of scope for this specification") はコールバック / オプション注入にする
3. `SubscribeOptions` / `FetchOptions` に `authorizationToken` フィールドを **新規追加** し、`buildSubscribeParameters` / `buildFetchParameters` が AUTHORIZATION_TOKEN を送出するようにする（既存経路の再利用ではなく新規追加）
4. 高レベル API (`createMediaSubscriber`) が catalog の `authInfo` を見て、トークン取得コールバック経由で取得したトークンを subscribe / fetch に渡す配線をする
5. トークン取得そのもの (外部 IdP) はコールバック / オプション注入にし、ライブラリ内に秘密情報を埋め込まない

## 完了条件

- `authInfo` 付き track の subscribe で AUTHORIZATION_TOKEN が付与される経路がある
- §11.4.3 の MUST 対象（SUBSCRIBE / FETCH / REQUEST_UPDATE / SUBSCRIBE_NAMESPACE）への付与経路がある
- トークン欠落時のエラーが呼び出し元に伝わる
- 選択した認可スキーム 1 つ以上の単体 / 結合テストがある
- `CHANGES.md` の `## develop` に `[ADD]` を追記する
- `vp run test` / `vp run build` が pass する

### 範囲外

- publisher 側（§5.2.37 `token` に基づく PUBLISH / PUBLISH_NAMESPACE への自動付与）は別 issue
- Privacy Pass / CAT のスキーム固有のトークン取得ロジック（§11.4.2 は "out of scope for this specification"）

## 関連

- `#0316` (closed) catalog 型までの先行対応
- `refs/moq/draft-ietf-moq-c4m-01.txt` / `draft-ietf-moq-privacy-pass-auth-03.txt`

## 解決方法

draft-ietf-moq-msf-01 §5.2.42 / §11.4.3 に基づき、subscriber 側の Authorization Token 自動付与を実装した。

- `src/session/params.ts`: `encodeAuthorizationTokenParameter()` helper を新設し、`buildSubscribeParameters()` / `buildFetchParameters()`（新設）/ `buildSubscribeNamespaceParameters()`（新設）が AUTHORIZATION_TOKEN (0x03) を送出する。
- `src/session.ts`: `SubscribeOptions` / `FetchOptions` に `authorizationToken` を追加。`fetch()` は `buildFetchParameters()` を使用。`subscribeNamespace()` は options で `authorizationToken` を受け付ける。`subscribe()` は `SubscriberImpl` にトークンを保持させる。
- `src/subscriber.ts`: `SubscriberImpl` が `authorizationToken` を保持（`setAuthorizationToken` / `getAuthorizationToken`）。
- `src/session/bidi.ts`: `bidiSendRequestUpdate()` が REQUEST_UPDATE に、`bidiSendJoiningFetch()` が Joining Fetch に、SUBSCRIBE 送信時のトークンを付与する（§11.4.3 の MUST 対象 4 メッセージ + Joining Fetch を網羅）。
- `src/createMediaSubscriber.ts`: 純粋関数 `resolveAuthorizationToken()` を export。`MediaSubscriberOptions.getAuthorizationToken` コールバック（§11.4.2、トークン取得は out of scope のため注入）でトークンを取得し、catalog の `authInfo`（§5.2.42）を持つ track の subscribe に付与する。トークンを取得できない場合はエラーを呼び出し元に伝播する（§11.4.4）。
- `src/codec/types.ts`: `MediaSubscriberOptions` に `getAuthorizationToken` コールバックを追加。
- テスト: `src/session/params.test.ts`（AUTHORIZATION_TOKEN 付与・USE_VALUE roundtrip）、`src/createMediaSubscriber.test.ts`（resolveAuthorizationToken のエラー伝播含む 6 件）、`src/session.prop.ts`（subscribeOptionsArb に authorizationToken 追加）。
- `CHANGES.md`: `## develop` に `[ADD]` を追記する。
- 範囲外（publisher 側 §5.2.37、スキーム固有トークン取得 §11.4.2）には踏み込んでいない。
