# Subgroup Header / Datagram デコーダの Publisher Priority バイト境界不足を修正する

- Priority: Low
- Created: 2026-08-16
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-publisher-priority-out-of-bounds-decode
- Polished: 2026-08-20

## 目的

`decodeSubgroupHeader` / `decodeObjectDatagram` が Publisher Priority バイトを範囲外アクセスで読み、バッファ不足時に undefined を取得する問題を修正する。

## 現状

- `src/dataStream.ts` の `decodeSubgroupHeader` と `decodeObjectDatagram` は、Priority Present のときに `data[offset + totalConsumed]` で Publisher Priority バイトを直接読む。バッファが Priority バイトの直前で切れている場合、範囲外アクセスにより undefined が返る (`Uint8Array` の範囲外インデックスアクセスは undefined を返す)。
- 実害は 2 経路で異なる:
  - subgroup ストリーム経路: undefined の `publisherPriority` を持つヘッダーが「成功」扱いになり、`handleSubgroupStream` へ遷移して Priority バイトが失われるため、ストリームのバイト列が 1 バイトずれて後続オブジェクトを誤デコードする。
  - datagram 経路: undefined が `publisherPriority` に代入されて `MoqtObject` 化され (`src/session/incoming.ts`)、subscriber へ不正な値として配信され得る (PRIORITY_FILTER 評価や配送で不正値として扱われる)。
- 受信側の `IncompleteDataError` の扱い:
  - subgroup ストリーム経路 (`src/session.ts` の `handleIncomingStream`) は `IncompleteDataError` を受けて次のチャンクを待つ (catch で continue)。
  - datagram 経路 (`src/session/incoming.ts` の `incomingHandleDatagram`) は `IncompleteDataError` を握りつぶし debug ログのみで黙殺する (datagram は QUIC のアトミック送信単位であり「次のチャンクを待つ」ことは構造的に不可能。既存の varint 不足と同じ扱い)。
- `decodeFetchObjectFields` は同様の問題を修正済み (Priority バイトの境界チェック + `IncompleteDataError`) だが、`decodeSubgroupHeader` / `decodeObjectDatagram` には未適用。
- 変更対象ファイル: `src/dataStream.ts` (`decodeSubgroupHeader` / `decodeObjectDatagram`)、`src/dataStream.subgroup.test.ts` / `src/dataStream.datagram.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- `decodeFetchObjectFields` と同じく、Priority バイトでバッファが不足している場合は `IncompleteDataError` を throw する。
- throw 後の受信側挙動は経路ごとに異なることを明記する:
  - subgroup ストリーム経路: `IncompleteDataError` により次のチャンクを待つ。
  - datagram 経路: `IncompleteDataError` は受信側 (`incomingHandleDatagram`) で黙殺され、該当 datagram が drop される (既存の varint 不足と同じ扱い)。datagram の不正データに対するセッション切断は行わない。
- なお `decodeObjectDatagram` の Properties フィールド (`data.slice` の切り詰め) にも同カテゴリの境界不足があるが、本 issue のスコープ外とする (別 issue の対応)。

## 完了条件

- Priority バイトでバッファが切れている場合に `decodeSubgroupHeader` / `decodeObjectDatagram` が `IncompleteDataError` を throw すること。
- subgroup ストリーム経路では `IncompleteDataError` により次のチャンクを待つこと、datagram 経路では黙殺されて drop されることが、受信側の既存経路で維持されること。
- 上記を検証するテストがあること (`src/dataStream.subgroup.test.ts` / `src/dataStream.datagram.test.ts` に、Priority バイト直前で切れたバッファを feed して `IncompleteDataError` を検証する。`decodeFetchObjectFields` の既存テスト (Priority バイトで切れていると IncompleteDataError) と同パターン)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

未着手。
