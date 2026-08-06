# SUBSCRIBE_TRACKS_ALLOWED_PARAMS がパラメータスコープ検証に組み込まれていない

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-subscribe-tracks-allowed-params-unwired
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope) に従い、SUBSCRIBE_TRACKS 受信時のパラメータスコープ検証を実装する。`SUBSCRIBE_TRACKS_ALLOWED_PARAMS` は定義されているが、`validateParameterScope` の呼び出しに組み込まれておらず、実装漏れの可能性が高い。

## 優先度根拠

`SUBSCRIBE_TRACKS_ALLOWED_PARAMS` は CHANGES.md で「新設」と記録されたが、生産コードの検証経路に接続されていない。受信 SUBSCRIBE_TRACKS に許可外パラメータが含まれても検出されず、§10.2.1 の MUST 要件を満たさない。Medium。

## 現状

- `src/message/parameterScope.ts:142` に `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` が定義されている (AUTH / FORWARD / GROUP_ORDER / Range Filters 5 種)。
- `validateParameterScope` の呼び出しは `bidi.ts` / `namespaceLoops.ts` / `session.ts` の 8 セットのみで、SUBSCRIBE_TRACKS 受信時の検証に `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` が使われていない。
- `parameterScope.test.ts` からのみ参照されており、実装漏れの可能性が高い。

## 設計方針

- 受信 SUBSCRIBE_TRACKS のパラメータ検証経路 (`src/session/namespaceLoops.ts` 等) に `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` を組み込む。
- 許可外パラメータを含む SUBSCRIBE_TRACKS を受信した場合は PROTOCOL_VIOLATION でセッションを閉じる (§10.2.1)。
- テストを追加して検証経路が機能することを確認する。

## 完了条件

- 受信 SUBSCRIBE_TRACKS のパラメータが `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` で検証されること。
- 許可外パラメータを含む SUBSCRIBE_TRACKS で PROTOCOL_VIOLATION になるテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope)
- draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS)

## 解決方法

未着手。
