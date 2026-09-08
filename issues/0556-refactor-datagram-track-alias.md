# decodeDatagramTrackAlias のワイヤ配置知識の重複を解消する

- Created: 2026-09-09
- Completed: YYYY-MM-DD
- Branch: feature/refactor-datagram-track-alias
- Polished: YYYY-MM-DD

## 目的

`src/session/incoming.ts` の `decodeDatagramTrackAlias` が `decodeObjectDatagram` の先頭 2 varint 配置（Type Flags → Track Alias）を再実装している。配置変更時に両方を直す必要があり、失敗時に誤った alias を引いて無関係な購読を cancel し得る。

## 現状

- `decodeObjectDatagram` は Type Flags → Track Alias の順でデコードする。
- `decodeDatagramTrackAlias` はデコード失敗時に同じ配置を再解析して alias を取り出す。

## 設計方針

1. `decodeObjectDatagram` の例外に trackAlias を持たせる、または先頭解析を共有ヘルパー化して 1 箇所に寄せる。
2. 挙動は変えない。

## 完了条件

- ワイヤ配置知識が 1 箇所になること。
- 既存テストが通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.3.1
- `decodeObjectDatagram` / `decodeDatagramTrackAlias`
