# 未使用の export (calculateAuthTokenSize / fallbackRegisterToUseValue / ObjectForwardingPreference) を削除する

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/refactor-moqt-draft-19-remove-unused-exports
- Polished: {YYYY-MM-DD}

## 目的

どこからも import されていない export を削除し、デッドコードを排除する。`calculateAuthTokenSize` / `fallbackRegisterToUseValue` はクライアント専用ライブラリでは使われないサーバー側処理の残骸、`ObjectForwardingPreference` は draft-17 以前の残骸で draft-19 では Subgroup Header Type のビットに統合済み。

## 優先度根拠

3 件ともリポジトリ全体 (テスト・index.ts を含む) から一切参照されていない。`ObjectForwardingPreference` は旧ドラフト対応の唯一の実質残骸であり、削除しても影響がない。Medium。

## 現状

- `src/message/authorizationToken.ts:231` `calculateAuthTokenSize` — 全コード・テストから未参照。index.ts / message/index.ts からも未 re-export。
- `src/message/authorizationToken.ts:248` `fallbackRegisterToUseValue` — 同上。REGISTER → USE_VALUE フォールバックはサーバー側処理。
- `src/message/types.ts:346-352` `ObjectForwardingPreference` — 全コード・テストから未参照。draft-19 では forwarding preference は Subgroup Header Type のビット (dataStream.ts `SubgroupHeaderType`) に統合済み。

## 設計方針

- 上記 3 シンボルの定義を削除する。
- 関連するコメント (旧ドラフトの言及) も整理する。
- 削除後に `tsc --noEmit` とテストが通ることを確認する。

## 完了条件

- 3 シンボルが削除され、リポジトリ内に参照が残らないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- 旧 draft-ietf-moq-transport-17 対応の残骸 (ObjectForwardingPreference)
- draft-ietf-moq-transport-19 §11.4.2 (Subgroup Header Type への統合)

## 解決方法

未着手。
