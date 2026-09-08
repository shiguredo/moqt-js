# LOC 単体デコーダの堅牢性を上げる

- Created: 2026-09-06
- Completed: 2026-09-08
- Branch: feature/fix-loc-decoder-robustness
- Polished: 2026-09-06

## 目的

公開の単体デコーダが誤 ID 入力を黙って受理し、内部ヘルパーの重複時勝敗と Config デコーダの view 返却の方針が不統一である。防御を揃える必要がある。

## 現状

- `src/loc.ts` の単体 `decode*` 6 種 (`decodeTimestamp` / `decodeTimescale` / `decodeVideoFrameMarking` / `decodeAudioLevel` / `decodeVideoConfig` / `decodeAudioConfig`) は先頭 varint を読み捨て、期待 ID と照合しない。
- 内部ヘルパー `extractLocProperties` の重複 ID 後勝ちが注釈されていない。
- `decodeVideoConfig` / `decodeAudioConfig` は入力への view を返す (`decodeLocObjectPayload` は独立コピーで不統一)。
- 切詰め検出は `decodeVideoConfig` / `decodeAudioConfig` のみ `0466` で対応中のため、残り 4 種の切詰めは本 issue の対象外とする (ID 照合に限定する)。

## 設計方針

1. 6 種に期待 ID 照合を追加し、不一致は `ProtocolViolationError` とする (英語メッセージ、期待値と実際値を含む。`decodeVideoFrameMarkingAfterId` および `0466` と同一契約)。適用は `0466` の後に行う (同一先頭部の競合回避)。
2. 重複時後勝ちは動作を変えず注釈する。view / コピーは独立コピーに統一する (`decodeLocObjectPayload` と同一方針)。
3. `src/loc.test.ts` に誤 ID 入力の `ProtocolViolationError` 検証を追加する (6 種)。

## 完了条件

- 6 種の誤 ID 入力が `ProtocolViolationError` になること。
- view 返却がなく、重複時後勝ちが注釈されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- `src/loc.ts` に `assertLocPropertyId` を追加し、6 種の単体デコーダで期待 ID 照合を行う。不一致は期待値と実際値を含む `ProtocolViolationError` とする。切詰め検出 (`0466`) との順序は ID 先・Length 後とした
- `decodeVideoConfig` / `decodeAudioConfig` の view 返却を独立コピーに統一し (`decodeLocObjectPayload` と同一方針)、JSDoc を更新した。重複 ID は有効な後続値が上書きする旨を注釈した
- `src/loc.test.ts` に誤 ID 6 件と独立コピー 2 件のテストを追加した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 関連

- `0466` (切詰め検出。本 issue は ID 照合と方針統一で分担する)
