# LOC 単体デコーダの堅牢性を上げる

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-loc-decoder-robustness
- Polished: YYYY-MM-DD

## 目的

単体デコーダが誤 ID 入力を黙って受理し、重複時の勝敗と view 返却の方針が不統一である。公開 API としての防御を揃える必要がある。

## 現状

- `src/loc.ts` の単体 `decode*` (6 種) は先頭 varint を読み捨て、期待 ID と照合しない。
- `extractLocProperties` の重複 ID 後勝ちが注釈されていない。
- `decodeVideoConfig` / `decodeAudioConfig` は入力への view を返す (`decodeLocObjectPayload` は独立コピーで不統一)。
- 切詰め検出は `0466` で対応中のため本 issue の対象外とする。

## 設計方針

1. 期待 ID 照合を追加し、不一致は `throw` する (単一 Property 前提の契約を明示)。
2. 重複時の後勝ちと view / コピーの方針を注釈または統一する。

## 完了条件

- 誤 ID 入力が検出されること。方針が注釈または実装で統一されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `0466` (切詰め検出。本 issue は ID 照合と方針統一で分担する)
