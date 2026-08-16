# Datagram / End of Range 直後の同一 Group・同一 Subgroup オブジェクトを Priority 不一致で誤検出する

- Priority: Low
- Created: 2026-08-16
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-fetch-priority-mismatch-after-non-subgroup-object
- Polished: {YYYY-MM-DD}

## 目的

FETCH 応答のデコードで、前オブジェクトが Subgroup を持たない (Datagram / End of Range) 場合に、同一 Group・同一 Subgroup の後続オブジェクトの Publisher Priority 不一致を誤検出する挙動を修正する。

## 現状

- `src/dataStream.ts` の `decodeFetchObjectFields` は、`FetchObjectContext` の `publisherPriority` を前オブジェクトの値で更新する。
- 前オブジェクトが Datagram の場合、`newContext.publisherPriority` が Datagram の Priority で上書きされる (Subgroup ID は引き継がれる)。そのため Datagram 直後の同一 Group・同一 Subgroup オブジェクトは Datagram の Priority と比較され、Priority が異なると誤検出される。
- 前オブジェクトが End of Range の場合、`decodeEndOfRange` は groupId のみ更新し、subgroupId / publisherPriority は旧オブジェクトの値を保持する。End of Range で Group が変わった後に SUBGROUP_SAME + PRIORITY_PRESENT のオブジェクトが続くと、無関係な旧 Group の Priority と比較され誤検出される。
- draft-ietf-moq-transport-19 §2.4.2 条件 1 の比較対象は「previous Object with the same Subgroup ID」であり、Subgroup を持たないオブジェクトは比較対象に含まれない。
- 誤検出時は対象 FETCH がキャンセルされる。セッション終了ではなくなったため影響は軽減されているが、正当な FETCH が誤ってキャンセルされる。
- Datagram 混在の誤検出は現行挙動としてテストに固定済み (`src/dataStream.fetch.test.ts` の「Datagram 直後の同一 Group・同一 Subgroup の Priority 不一致は検出される (既知の誤検出を固定)」)。

## 設計方針

- `FetchObjectContext` に「前オブジェクトが Subgroup を持っていたか」を保持し、Priority 比較を「前オブジェクトが Subgroup を持つ場合」に限定する。
- Datagram / End of Range 直後のオブジェクトは、直近の Subgroup オブジェクトの Priority と比較する。
- 既存の誤検出固定テストを、修正後の挙動 (誤検出しない) に書き換える。

## 完了条件

- 同一 Group 内で Datagram を挟んだ後の同一 Subgroup オブジェクトが、Datagram と異なる Priority でも誤検出されないこと。
- End of Range で Group が変わった後の同一 Subgroup ID オブジェクトが、旧 Group の Priority と比較されないこと。
- 上記を検証するテストがあること。

## 解決方法

未着手。
