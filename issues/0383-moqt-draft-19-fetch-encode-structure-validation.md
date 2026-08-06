# FETCH encode 側の構造検証が欠落している

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-fetch-encode-structure-validation
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §10.12 の FETCH メッセージ構造に従い、encode 時に Fetch Type と Standalone / Joining 構造の整合を検証する。現在は fetchType が 1/2/3 以外でも、standalone / joining が未設定でもそのまま誤エンコードされる。

## 優先度根拠

decode 側 (`src/message/fetch.ts:152-159`) は Fetch Type 1/2/3 以外を PROTOCOL_VIOLATION で拒否するが、encode 側に対称の検証がない。不正なメッセージを黙ってワイヤに載せる経路が残る。Low。

## 現状

- `src/message/fetch.ts:81-114` (`encodeFetchPayload`) は `fetchType === FetchType.STANDALONE && msg.standalone` のときのみ Standalone 構造を書き、standalone / joining が未設定でもエラーにしない。
- fetchType が 1/2/3 以外でもそのままエンコードされる (decode 側は `fetch.ts:152-159` で拒否)。

## 設計方針

- `encodeFetchPayload` に Fetch Type と構造の整合検証を追加する:
  - STANDALONE (0x1) は standalone 必須、joining 禁止
  - JOINING_RELATIVE (0x2) / JOINING_ABSOLUTE (0x3) は joining 必須、standalone 禁止
  - それ以外の fetchType はエラー
- 不正な入力には既存のエラー規約 (英語メッセージの Error) に合わせて throw する。

## 完了条件

- 不正な Fetch Type や構造の組み合わせで `encodeFetchPayload` が throw すること。
- 正常な 3 種の Fetch Type は従来どおりエンコードされること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.12 (FETCH)
- draft-ietf-moq-transport-19 §10.12.1 (Standalone Fetch)
- draft-ietf-moq-transport-19 §10.12.2 (Joining Fetches)

## 解決方法

未着手。
