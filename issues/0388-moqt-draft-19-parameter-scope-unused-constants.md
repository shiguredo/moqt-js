# parameterScope の未使用許可パラメータ集合を整理する

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/refactor-moqt-draft-19-parameter-scope-unused-constants
- Polished: {YYYY-MM-DD}

## 目的

`src/message/parameterScope.ts` のうち生産コードから使用されていない許可パラメータ集合を整理する。SUBSCRIBE / FETCH / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の受信はサーバー側責務のためクライアント専用ライブラリでは不要であり、`SUBSCRIBE_TRACKS_ALLOWED_PARAMS` は検証に組み込まれていない (配線漏れの可能性) ため扱いを確定する。

## 優先度根拠

`validateParameterScope` の呼び出しは bidi.ts / namespaceLoops.ts / session.ts の 8 セットのみで、`SUBSCRIBE_ALLOWED_PARAMS` / `FETCH_ALLOWED_PARAMS` / `NAMESPACE_ALLOWED_PARAMS` / `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` は生産コードから未使用 (テストからのみ参照)。Low。

## 現状

- `src/message/parameterScope.ts:20` `SUBSCRIBE_ALLOWED_PARAMS` — 生産コード・テストから未使用。
- `src/message/parameterScope.ts:103` `FETCH_ALLOWED_PARAMS` — 同上。
- `src/message/parameterScope.ts:133` `NAMESPACE_ALLOWED_PARAMS` — 同上。
- `src/message/parameterScope.ts:142` `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` — 生産コード未使用。`parameterScope.test.ts` からのみ参照。CHANGES.md で「新設」されたが、実際の `validateParameterScope` 呼び出しに組み込まれていない。

## 設計方針

- SUBSCRIBE / FETCH / SUBSCRIBE_NAMESPACE 受信はサーバー側責務のため、`SUBSCRIBE_ALLOWED_PARAMS` / `FETCH_ALLOWED_PARAMS` / `NAMESPACE_ALLOWED_PARAMS` は削除する。
- `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` は配線漏れの可能性があるため、受信 SUBSCRIBE_TRACKS の検証経路に組み込むか、他の未使用定数と同様に削除するかを確認して確定する (配線する場合は本 issue ではなく別 issue で対応する可能性がある)。
- テスト (`parameterScope.test.ts`) の参照も整理する。

## 完了条件

- 未使用の許可パラメータ集合が削除または配線され、実態と一致すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 注記 (0371 実装時)

- 0371 (未対応リクエストの NOT_SUPPORTED 応答) 実装後は、受信 SUBSCRIBE_TRACKS が NOT_SUPPORTED で閉じられるため、`SUBSCRIBE_TRACKS_ALLOWED_PARAMS` の受信検証への配線は不可能になる。本 issue は「削除」に収束する (未使用定数として削除)。

## 注記 (0373 実装時)

- 0373 (受信 PUBLISH ストリーム上の REQUEST_UPDATE 誤検知) の実装で `PUBLISH_REQUEST_UPDATE_OK_PARAMS` (`src/message/parameterScope.ts`) を新設した。同定数は `src/session/bidi.ts` の `bidiHandlePublishRequestUpdate` (production から使用) で参照されるため、削除対象外である。本 issue の未使用定数整理時には使用箇所を確認すること。

## 参照

- draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope)

## 解決方法

未着手。
