# Subgroup Header / Datagram デコーダの Publisher Priority バイト境界不足を検出する

- Priority: Low
- Created: 2026-08-16
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-publisher-priority-out-of-bounds-decode
- Polished: {YYYY-MM-DD}

## 目的

`decodeSubgroupHeader` / `decodeObjectDatagram` が Publisher Priority バイトを範囲外アクセスで読み、バッファ不足時に undefined を取得する問題を修正する。

## 現状

- `src/dataStream.ts` の `decodeSubgroupHeader` と `decodeObjectDatagram` は、Priority Present のときに `data[offset + totalConsumed]` で Publisher Priority バイトを直接読む。バッファが Priority バイトの直前で切れている場合、範囲外アクセスにより undefined が返る。
- 受信ループはデータ不足を `IncompleteDataError` で検出して次のチャンクを待つ設計だが、Priority バイトの読みは範囲外チェックがなく、undefined が `publisherPriority` に代入されて不正な値として扱われ得る。
- `decodeFetchObjectFields` は同様の問題を修正済み (Priority バイトの境界チェック + `IncompleteDataError`) だが、`decodeSubgroupHeader` / `decodeObjectDatagram` には未適用。

## 設計方針

- `decodeFetchObjectFields` と同じく、バッファ不足時は `IncompleteDataError` を throw して次のチャンクを待たせる。

## 完了条件

- Priority バイトでバッファが切れている場合に `decodeSubgroupHeader` / `decodeObjectDatagram` が `IncompleteDataError` を throw すること。
- 上記を検証するテストがあること。

## 解決方法

未着手。
