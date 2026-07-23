# MSF の Authorization Token 自動付与を実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/add-msf-authorization-token-auto-attach
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-msf-01 §5.2.42 `authInfo` / §5.2.37 `token` / §11.4.3 では、catalog が認可を要求する場合に SUBSCRIBE / FETCH 等へ Authorization Token を付与する必要がある。現状は catalog 型と検証のみで、高レベル API が `authInfo` を見てトークンを自動付与しない。

## 優先度根拠

認可付き配信ではトークン欠落で REQUEST_ERROR になり再生できない。一方、認可なしカタログでは不要。媒体一般のブロッカーではないため Medium。

## 現状

- `CatalogTrack.authInfo` / `token` / `connectionUri` は型・MUST 検証済み (`src/msf.ts`)
- `createMediaPublisher` / `createMediaSubscriber` の `authorizationToken` は **接続オプション** として SETUP に載せる用途 (`createMediaSubscriber.ts:324` 付近)
- catalog の `authInfo` を読んでトラック subscribe 時に AUTHORIZATION_TOKEN パラメータを付与する経路は無い
- `#0316` 範囲外: 「§11.4.3 Authorization Token の SUBSCRIBE / SUBSCRIBE_NAMESPACE / FETCH / REQUEST_UPDATE / PUBLISH / PUBLISH_NAMESPACE への MUST 自動付与」

## 設計方針

1. catalog 受信後、対象 track に `authInfo` がある場合のトークン取得・付与フローを設計する
2. Privacy Pass / CAT (`refs/moq/draft-ietf-moq-privacy-pass-auth-03.txt` / `draft-ietf-moq-c4m-01.txt`) のどちらを先にサポートするかは実装時に 1 方式に絞る (両方同時は別 issue)
3. Session の subscribe / fetch API へ AUTHORIZATION_TOKEN を渡す既存経路を再利用する
4. トークン取得そのもの (外部 IdP) はコールバック / オプション注入にし、ライブラリ内に秘密情報を埋め込まない

## 完了条件

- `authInfo` 付き track の subscribe で AUTHORIZATION_TOKEN が付与される経路がある
- トークン欠落時のエラーが呼び出し元に伝わる
- 選択した認可スキーム 1 つ以上の単体 / 結合テストがある
- `vp run test` / `vp run build` が pass する

## 関連

- `#0316` (closed) catalog 型までの先行対応
- `refs/moq/draft-ietf-moq-c4m-01.txt` / `draft-ietf-moq-privacy-pass-auth-03.txt`
