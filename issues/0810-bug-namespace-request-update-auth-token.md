# namespace 系 REQUEST_UPDATE に Authorization Token を付与するかを決める

- Created: 2026-10-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-namespace-request-update-auth-token
- Polished: 2026-10-03

## 目的

draft-ietf-moq-msf-01 §11.4.3 は「track に紐づくトークンは AUTHORIZATION TOKEN パラメータを受け付ける、その track に関連するすべての制御メッセージに MUST 付与する。end subscriber では SUBSCRIBE / SUBSCRIBE_NAMESPACE / FETCH / REQUEST_UPDATE が該当する」と定める。§11.4.3 の列挙に SUBSCRIBE_NAMESPACE と REQUEST_UPDATE が含まれており、`Session.subscribeNamespace` も §11.4.3 に従い「SUBSCRIBE_NAMESPACE に MUST 付与」としている (JSDoc 参照)。

moqt-js の高レベル API (`createMediaSubscriber` / `createMediaPublisher` / devtools の `trackAuthorization`) は SETUP に載せたトークン (`Session.setupAuthorizationToken`) を SUBSCRIBE / FETCH / PUBLISH などの `authorizationToken` オプションへ自動付与する。低レベル API の `Session.subscribeNamespace` / `Session.subscribeTracks` も `authorizationToken` オプションとして受け取り SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS へ付与するが、**namespace 系の REQUEST_UPDATE (`NamespaceSubscription.update` / `TracksSubscription.update`) には付与していない**。§9.5 は AUTHORIZATION_TOKEN の出現を SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS 向け REQUEST_UPDATE に許可しており、付与の可否を仕様に照らして決める必要がある。

## 現状

- `src/session/bidi.ts` の `bidiSendNamespaceRequestUpdate` は TRACK_NAMESPACE_PREFIX (§9.20.20) を積み、`TracksUpdateOptions` の FORWARD (§9.20.18) は SUBSCRIBE_TRACKS の場合だけ積むが、AUTHORIZATION_TOKEN は積まない
- 同じ namespace 系でも初回要求 (`src/session/namespaces.ts` の SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) は `authorizationToken` オプションを受け取り、0807 で送信時の正規化 (USE_ALIAS / USE_VALUE) も適用済みである
- subscription 系の REQUEST_UPDATE (`src/session/bidi.ts` の `bidiSendRequestUpdate`) は `Subscriber.getAuthorizationToken()` の値を使うため付与される。REQUEST_UPDATE 用の値は `requestsTokenForRequestUpdate` で REGISTER を USE_ALIAS に変換して保持する (`src/session/requests.ts`)
- MSF §11.4.3 の MUST は「track に紐づくトークン」が対象であり、namespace 系 REQUEST_UPDATE (prefix 更新 / FORWARD 更新) が track に紐づくといえるかは自明ではない (初回要求の SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS は §11.4.3 の列挙に含まれるが、更新対象は track ではなく prefix である)

## 設計方針

- MSF §11.4.3 と MOQT §9.5 を読み、namespace 系 REQUEST_UPDATE への付与が MUST / MAY / 不要のどれかを判断し、結論と根拠をコードコメントに記録する (`bidiSendNamespaceRequestUpdate` の JSDoc)
- 付与が必要と判断した場合は、`NamespaceUpdateOptions` / `TracksUpdateOptions` に `authorizationToken` を加えて初回要求と同じトークンを受け取り、0807 の正規化 (`requestsNormalizeAuthorizationToken`) を通して積む。また、初回要求で REGISTER を送った Alias は `requestsTokenForRequestUpdate` で USE_ALIAS に変換する (再 REGISTER は DUPLICATE_AUTH_TOKEN_ALIAS でセッションを閉じるため、subscription 系と同じ正規化が必要)
  - namespace サブスクリプション (`NamespaceSubscriptionState` / `TracksSubscriptionState`) はトークンを保持していない。`update()` ごとに明示指定するか、初回要求時のトークンを状態に保持して自動付与するかは実装方針として決める
- 付与が不要と判断した場合は、その根拠 (track に紐づかないため MSF §11.4.3 の MUST の対象外である等) を `bidiSendNamespaceRequestUpdate` の JSDoc に記録する
- 判断の結果は CHANGES.md に反映する (挙動変更がある場合のみ)

## 完了条件

- namespace 系 REQUEST_UPDATE に AUTHORIZATION_TOKEN を付与するかの判断と根拠がコードコメントに記録されている
- 付与すると判断した場合は実装とテストが入り、付与しないと判断した場合はその根拠が仕様の該当節とともに示されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-msf-01 §11.4.3 (Presenting Authorization)
- draft-ietf-moq-transport-22 §9.5 (REQUEST_UPDATE) / §9.20.2 (AUTHORIZATION TOKEN Parameter)
- `src/session/bidi.ts` の `bidiSendNamespaceRequestUpdate` / `bidiSendRequestUpdate`
- `src/session/namespaces.ts` の SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS 送信経路
- `src/session/requests.ts` の `requestsNormalizeAuthorizationToken` / `requestsTokenForRequestUpdate`
- `src/session/publicTypes.ts` の `NamespaceUpdateOptions` / `TracksUpdateOptions`
- `src/session.ts` の `Session.subscribeNamespace` (JSDoc)
- 関連 issue: 0807 (Authorization Token の送信時正規化)

## 解決方法

{未着手}
