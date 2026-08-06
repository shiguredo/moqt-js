# TRACK_NAMESPACE_PREFIX による namespace サブスクリプション更新 API がない

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/add-moqt-draft-19-track-namespace-prefix-update-api
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions) で定義される TRACK_NAMESPACE_PREFIX パラメータ (0x34) による SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の prefix 更新 API を追加する。現在はエンコード / デコードのみ実装されており、ユーザーが利用できる API が存在しない。

## 優先度根拠

§10.9.2 は「A subscriber can update the Track Namespace Prefix of an established SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS by including the TRACK_NAMESPACE_PREFIX parameter in a REQUEST_UPDATE.」を定める。codec は実装済みだが API 未接続のため、仕様の機能が利用できない。Low。

## 現状

- `src/message/parameter.ts:960-975` に `encodeTrackNamespacePrefixParameter()` / `decodeTrackNamespacePrefixParameter()` が実装されている。
- `src/message/parameterScope.ts:93` で REQUEST_UPDATE の許可パラメータに含まれている。
- しかし `src/session.ts` の `subscribeNamespace()` / `subscribeTracks()` や REQUEST_UPDATE 送信経路 (`bidiSendRequestUpdate`) に prefix 更新のオプションが存在しない。

## 設計方針

- `subscribeNamespace()` / `subscribeTracks()` に namespace prefix 更新用のオプション (REQUEST_UPDATE で TRACK_NAMESPACE_PREFIX を送信する API) を追加する。
- §10.9.2 の制約 (新 prefix が他のアクティブな SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS と共通 prefix を持たないこと) を送信前に検証する。
- REQUEST_OK 受信後の NAMESPACE / NAMESPACE_DONE が更新後の prefix に対する suffix になることを状態管理に反映する。

## 完了条件

- REQUEST_UPDATE で TRACK_NAMESPACE_PREFIX を送信して SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の prefix を更新できる API があること。
- 更新後の NAMESPACE / NAMESPACE_DONE の suffix 解決が新しい prefix に基づくこと。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.9.2 (Updating Namespace Subscriptions)
- draft-ietf-moq-transport-19 §10.2.19 (TRACK_NAMESPACE_PREFIX Parameter)

## 解決方法

未着手。
