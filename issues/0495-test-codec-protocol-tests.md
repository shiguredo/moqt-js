# codec Wrapper と Worker プロトコルをテストする

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/add-codec-protocol-tests
- Polished: YYYY-MM-DD

## 目的

Wrapper の状態遷移と Worker メッセージ対応が未テストで、初期化ハング等の経路を検出できない。契約をテストまたは文書化する必要がある。

## 現状

- `src/codec/` のテストは `config.test.ts` (codec 文字列マッピング) のみである。
- `configured` フラグと実 `encoder.state` の二重管理、Worker 型 (`configured` / `encoded` / `decoded` / `skipped` / `error`) の送受信対応が未検証である。

## 設計方針

1. ブラウザ非依存の契約テスト (メッセージ shapes、状態遷移) を追加する。
2. 実ブラウザ実行が必要な範囲は方針 (E2E 寄せ等) を決める。

## 完了条件

- Wrapper / Worker の契約がテストまたは文書で pin されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
