# FETCH encode 側の構造検証が欠落している

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-fetch-encode-structure-validation
- Polished: 2026-08-12

## 目的

draft-ietf-moq-transport-19 §10.12 の FETCH メッセージ構造に従い、encode 時に Fetch Type と Standalone / Joining 構造の整合を検証する。現在は fetchType が 1/2/3 以外でも、standalone / joining が未設定でもそのまま誤エンコードされる。

## 優先度根拠

decode 側 (`decodeFetchPayload` の switch の default 分岐) は Fetch Type 1/2/3 以外を PROTOCOL_VIOLATION で拒否するが、encode 側に対称の検証がない。内部の呼び出し元 (`fetch()` / `bidiSendJoiningFetch`) は常に正しい構造を構築するため現状のバグが実際にワイヤに出る経路はないが、`encodeFetchPayload` は公開エクスポートされており、ライブラリ利用者が直接呼ぶ・将来の改修でバグを入れるケースへの防御として検証が必要。Low。

## 現状

- `encodeFetchPayload` (`src/message/fetch.ts`) は `fetchType === FetchType.STANDALONE && msg.standalone` のときのみ Standalone 構造を書き、standalone / joining が未設定でもエラーにしない。また `else if (msg.joining)` は fetchType を検査しないため、fetchType=STANDALONE で standalone 未設定 + joining 設定の場合に Joining 構造が黙って書かれ、fetchType=JOINING 系で standalone 設定 + joining 未設定の場合に構造が一切書かれない (不整合な構造が黙ってエンコードされる)。
- fetchType が 1/2/3 以外でもそのままエンコードされる (decode 側は `decodeFetchPayload` の switch の default 分岐で ProtocolViolationError により拒否)。
- `FetchType` は 0x01 / 0x02 / 0x03 のユニオン型 (`FetchType.STANDALONE` / `FetchType.RELATIVE_JOINING` / `FetchType.ABSOLUTE_JOINING`) であり型レベルで防がれるが、`as FetchType` キャストや公開 API 経由の入力で不正値が入り得る。
- 変更対象ファイル: `src/message/fetch.ts` (`encodeFetchPayload` への検証追加)、`src/message/fetch.test.ts` (新規作成。エラーパスの単体テスト)、`CHANGES.md`。

## 設計方針

- `encodeFetchPayload` の先頭に Fetch Type と構造の整合検証を追加する:
  - `FetchType.STANDALONE` (0x1) は standalone 必須、joining 禁止
  - `FetchType.RELATIVE_JOINING` (0x2) / `FetchType.ABSOLUTE_JOINING` (0x3) は joining 必須、standalone 禁止
  - それ以外の fetchType はエラー
- 不正な入力には既存のエラー規約 (英語メッセージの Error。末尾ピリオドなし、期待値と実際の値を示す) に合わせて throw する。decode 側の先例 (`unknown fetch type: 0x${...}, expected 0x1, 0x2, or 0x3`) と同形式のメッセージにする。decode 側の ProtocolViolationError (ピアの違反を検証する MUST) とは区別し、encode 側は自コードのバグの防御であるためプレーンな Error で throw する。
- テスト: エラーパス (fetchType 不正 / STANDALONE で standalone なし / STANDALONE で joining あり / JOINING 系で joining なし / JOINING 系で standalone あり) は既存の PBT の arbitrary では生成できない (`src/message/fetch.prop.ts` は整合の取れた値のみを生成する) ため、`src/message/fetch.test.ts` を新規作成して単体テストで検証する。なお `Fetch` 型の `standalone?` / `joining?` は独立したオプショナルであり、fetchType と不整合なオブジェクトは型上作れてしまう点に注意する。既存の PBT は正常な組み合わせのみを生成するため、検証追加後も壊れない。

## 完了条件

- 不正な Fetch Type や構造の組み合わせで `encodeFetchPayload` が throw すること (fetchType 不正 / STANDALONE で standalone なし / STANDALONE で joining あり / JOINING 系で joining なし / JOINING 系で standalone あり の 5 ケース。throw が ProtocolViolationError でないことの検証を含む)。
- 正常な 3 種の Fetch Type は従来どおりエンコードされること。
- 上記を検証するテストがあること (`src/message/fetch.test.ts` の新規作成)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.12 (FETCH / Fetch Type の定義と 1/2/3 以外の MUST)
- draft-ietf-moq-transport-19 §10.12.1 (Standalone Fetch)
- draft-ietf-moq-transport-19 §10.12.2 (Joining Fetches)
- draft-ietf-moq-transport-19 §10.12.3 (FETCH Message / Standalone は Fetch Type 0x1 のとき、Joining は 0x2 / 0x3 のときに含まれる)

## 解決方法

未着手。
