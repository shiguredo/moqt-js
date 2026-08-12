# parameterScope の未使用許可パラメータ集合を整理する

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/refactor-moqt-draft-19-parameter-scope-unused-constants
- Polished: 2026-08-12

## 目的

`src/message/parameterScope.ts` のうち生産コードから使用されていない許可パラメータ集合を削除する。SUBSCRIBE / FETCH / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の受信はサーバー側責務であり、0371 により受信リクエストはペイロード非デコード + NOT_SUPPORTED 応答となったため、受信検証に使われることはない。

## 優先度根拠

`validateParameterScope` に渡される許可パラメータ集合は 8 種類のみ (PUBLISH_ALLOWED_PARAMS / NAMESPACE_OK_ALLOWED_PARAMS / PUBLISH_OK_ALLOWED_PARAMS / SUBSCRIBE_OK_ALLOWED_PARAMS / FETCH_OK_ALLOWED_PARAMS / TRACK_STATUS_OK_ALLOWED_PARAMS / REQUEST_UPDATE_ALLOWED_PARAMS / REQUEST_UPDATE_OK_ALLOWED_PARAMS。`PUBLISH_REQUEST_UPDATE_OK_PARAMS` は `.some()` で使用)。`SUBSCRIBE_ALLOWED_PARAMS` / `FETCH_ALLOWED_PARAMS` / `NAMESPACE_ALLOWED_PARAMS` は生産コード・テストからも未使用であり、`SUBSCRIBE_TRACKS_ALLOWED_PARAMS` はテストからのみ参照される (詳細は現状参照)。Low。

## 現状

- `SUBSCRIBE_ALLOWED_PARAMS` (`src/message/parameterScope.ts`) — 生産コード・テストから未使用。
- `FETCH_ALLOWED_PARAMS` (`src/message/parameterScope.ts`) — 同上。
- `NAMESPACE_ALLOWED_PARAMS` (`src/message/parameterScope.ts`) — 同上。
- `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` (`src/message/parameterScope.ts`) — 生産コード未使用。`parameterScope.test.ts` からのみ参照。0371 により受信 SUBSCRIBE_TRACKS はペイロード非デコード + NOT_SUPPORTED 応答のため、受信検証への配線は不可能。
- 変更対象ファイル: `src/message/parameterScope.ts` (4 定数の削除)、`src/message/parameterScope.test.ts` (`SUBSCRIBE_TRACKS_ALLOWED_PARAMS` を参照するテスト 2 件と import の削除)、`CHANGES.md`。

## 設計方針

- `SUBSCRIBE_ALLOWED_PARAMS` / `FETCH_ALLOWED_PARAMS` / `NAMESPACE_ALLOWED_PARAMS` / `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` の 4 定数を**削除する** (0371 の注記で確定済み。配線は不可能のため)。
- `PUBLISH_REQUEST_UPDATE_OK_PARAMS` は `src/session/bidi.ts` の `bidiHandlePublishRequestUpdate` (production から使用) で参照されるため削除対象外。0377 が FORWARD を追加するため、0377 実装時に本 issue の注記 (0373 実装時) を更新すること。
- テスト (`parameterScope.test.ts`) の `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` を参照するテスト 2 件 (「SUBSCRIBE_TRACKS_ALLOWED_PARAMS は AUTH / FORWARD / GROUP_ORDER / Range Filters を含む」と「SUBSCRIBE_TRACKS で許可外パラメータは拒否される」) と import を削除する (他の定数のテストは残る)。
- 削除後に `tsc --noEmit` とテストが通ることを確認する。

## 完了条件

- 4 定数が削除され、リポジトリ内に参照が残らないこと (テストを含む)。
- `issues/0389` に「対象喪失によるクローズまたは削除への収束」の注記が追加されていること (0389 は本 issue の削除確定により対象を失うため、本 issue の実装時に注記を追加する)。
- `CHANGES.md` の `## develop` の `### misc` に `[CHANGE]` エントリがあること (シンボル削除を伴う変更の先例に従い [CHANGE] で記載する。先例: 「[CHANGE] PublishOk 型と encodePublishOkPayload を削除する (#0290)」)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope)
- draft-ietf-moq-transport-19 §10.19.1 (Parameters on SUBSCRIBE_TRACKS / `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` の根拠)
- 関連: `issues/closed/0371-moqt-draft-19-incoming-request-not-supported-response.md`（受信リクエスト 6 種のペイロード非デコード。削除への収束を確定した元）
- 関連: `issues/closed/0373-moqt-draft-19-request-update-on-publish-stream-misdetected.md`（`PUBLISH_REQUEST_UPDATE_OK_PARAMS` の削除対象外注記）
- 関連: `issues/0377-moqt-draft-19-publish-forward-param-not-applied.md`（`PUBLISH_REQUEST_UPDATE_OK_PARAMS` に FORWARD を追加予定。0377 実装時に本 issue の注記 (0373 実装時) を更新すること）
- 関連: `issues/0389-moqt-draft-19-subscribe-tracks-allowed-params-unwired.md`（`SUBSCRIBE_TRACKS_ALLOWED_PARAMS` の配線が目的。本 issue の削除確定により対象を失うため、0389 側でクローズまたは削除へ収束する。実装順は本 issue が先）

## 注記 (0371 実装時)

- 0371 実装後の受信 bidi ストリームの 3 分類により、受信 SUBSCRIBE_TRACKS は NOT_SUPPORTED で閉じられペイロードをデコードしないため、`SUBSCRIBE_TRACKS_ALLOWED_PARAMS` の受信検証への配線は不可能である。本 issue は「削除」に収束する (設計方針・完了条件に反映済み)。0389 は本 issue の削除確定により対象を失うため、0389 側でクローズまたは削除へ収束する。

## 注記 (0373 実装時)

- 0373 の実装で `PUBLISH_REQUEST_UPDATE_OK_PARAMS` (`src/message/parameterScope.ts`) を新設した。同定数は `src/session/bidi.ts` の `bidiHandlePublishRequestUpdate` (production から使用) で参照されるため、削除対象外である。0377 が FORWARD を追加するため、0377 実装時に本注記を更新すること。

## 解決方法

未着手。
