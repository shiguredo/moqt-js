# CHANGES.md の DATAGRAM エントリの記述重複を整理する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/update-changelog-datagram-entry
- Polished: YYYY-MM-DD

## 目的

`CHANGES.md` の `## develop` で、0242 の `[ADD]` エントリと 0535 の `[FIX]` エントリが同じ DATAGRAM の Subgroup ID 挙動を二重に説明している。未リリース機能の説明が分散して読みにくい。

## 現状

- `[ADD] Fetch Object Fields の DATAGRAM ビット (0x40) 対応を実装する` が DATAGRAM 時の Serialization Flags の扱いを説明する。
- `[FIX] FETCH の DATAGRAM フラグで Subgroup ID を消費しないようにする` が旧挙動の誤りを説明する。
- 両者は同じ `## develop` セクション内にあり、未リリース機能の最終挙動が 2 か所に分かれている。

## 設計方針

1. 未リリース機能の最終挙動が 1 か所で分かるように、`[ADD]` と `[FIX]` の記述を整理する。
2. 履歴として残すべき情報（旧挙動からの修正であること）は残しつつ、重複を避ける。
3. リリース済みセクションの記述は変更しない。

## 完了条件

- DATAGRAM の Subgroup ID 挙動の説明が重複せず、最終挙動が読み取れること。
- `vp check` が通ること。

## 関連

- `CHANGES.md` の 0242 / 0535 エントリ
