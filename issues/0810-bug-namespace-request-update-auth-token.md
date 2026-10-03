# namespace 系 REQUEST_UPDATE に Authorization Token を付与するかを決める

- Created: 2026-10-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-namespace-request-update-auth-token
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-msf-01 §11.4.3 は「track に紐づくトークンは AUTHORIZATION TOKEN パラメータを受け付ける、その track に関連するすべての制御メッセージに MUST 付与する。end subscriber では SUBSCRIBE / SUBSCRIBE_NAMESPACE / FETCH / REQUEST_UPDATE が該当する」と定める。

moqt-js は SETUP に載せたトークン (`SessionImpl.setupAuthorizationToken`) を SUBSCRIBE / FETCH / PUBLISH / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS などの `authorizationToken` オプションへ自動付与するが、**namespace 系の REQUEST_UPDATE には付与していない**。§9.5 は AUTHORIZATION_TOKEN の出現を SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS 向け REQUEST_UPDATE に許可しており、付与の可否を仕様に照らして決める必要がある。

## 現状

- `src/session/bidi.ts` の `bidiSendNamespaceRequestUpdate` は TRACK_NAMESPACE_PREFIX (§9.20.20) と FORWARD (§9.20.18) だけを積み、AUTHORIZATION_TOKEN を積まない
- 同じ namespace 系でも初回要求 (`src/session/namespaces.ts` の SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) は `authorizationToken` オプションを受け取り、0807 で送信時の正規化 (USE_ALIAS / USE_VALUE) も適用済みである
- subscription 系の REQUEST_UPDATE (`src/session/bidi.ts` の送信経路) は `Subscriber.getAuthorizationToken()` の値を使うため付与される
- MSF §11.4.3 の MUST は「track に紐づくトークン」が対象であり、namespace 系 REQUEST_UPDATE (prefix 更新 / FORWARD 更新) が track に紐づくといえるかは自明ではない

## 設計方針

- MSF §11.4.3 と MOQT §9.5 を読み、namespace 系 REQUEST_UPDATE への付与が MUST / MAY / 不要のどれかを判断し、結論と根拠をコメントに記録する
- 付与が必要と判断した場合は、初回要求と同じトークンを `authorizationToken` オプション経由で受け取り、0807 の正規化 (`requestsNormalizeAuthorizationToken`) を通して積む。API 追加が必要なら `TracksUpdateOptions` / namespace 更新系のオプションに加える
- 付与が不要と判断した場合は、その根拠 (track に紐づかないため MSF §11.4.3 の MUST の対象外である等) を `bidiSendNamespaceRequestUpdate` の JSDoc に記録する
- 判断の結果は CHANGES.md に反映する (挙動変更がある場合のみ)

## 完了条件

- namespace 系 REQUEST_UPDATE に AUTHORIZATION_TOKEN を付与するかの判断と根拠がコードコメントに記録されている
- 付与すると判断した場合は実装とテストが入り、付与しないと判断した場合はその根拠が仕様の該当節とともに示されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-msf-01 §11.4.3 (Presenting Authorization)
- draft-ietf-moq-transport-22 §9.5 (REQUEST_UPDATE) / §9.20.2 (AUTHORIZATION TOKEN Parameter)
- `src/session/bidi.ts` の `bidiSendNamespaceRequestUpdate`
- `src/session/namespaces.ts` の SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS 送信経路
- `src/session/requests.ts` の `requestsNormalizeAuthorizationToken`
- 関連 issue: 0807 (Authorization Token の正規化)

## 解決方法

{未着手}
