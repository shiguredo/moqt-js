# Subgroup が交互に出現する FETCH 応答で同一 Subgroup の Priority 不一致を検出できない

- Created: 2026-08-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-fetch-interleaved-subgroup-priority-miss
- Polished: {YYYY-MM-DD}

## 目的

FETCH 応答のデコードで、Subgroup が交互に出現する場合 (S1 → S2 → S1) に、§2.4.2 条件 1「An Object with a particular Subgroup ID is received, but its Publisher Priority is different from that of the previous Object with the same Subgroup ID.」の検出ができない。比較対象が「直前オブジェクトのコンテキスト」のみのため、交互出現では同一 Subgroup ID の直前オブジェクトを追跡できない。Subgroup ID ごとの直近 Priority を追跡するように拡張する。

## 現状

- `checkSubgroupPriorityMismatch` (`src/dataStream.ts`) は、現在グループ内の直前 1 オブジェクトのコンテキスト (`FetchObjectContext`) の `subgroupPublisherPriority` のみと比較する。
- S1(P100) → S2(P200) → S1(P150) のように Subgroup が交互すると、S1 再出現時のコンテキストは S2 のため `subgroupId === context.subgroupId` が false となり比較されない。影響: 検出漏れのみ (誤検出なし)。不正な Publisher のデータがそのまま配信され、FETCH キャンセル (MalformedTrackError) が発火しない。
- closed issue 0420 の修正 (誤検出修正) 時に、この検出漏れは「従来から存在する既存ギャップ」として記録された (0420 の解決方法参照)。
- §2.4.2 条件 1 の比較対象は「previous Object with the same Subgroup ID」であり、厳密には Subgroup ID ごとの直前オブジェクトを追跡する必要がある。

## 設計方針

- `FetchObjectContext` を拡張し、現在 Group 内の Subgroup ID ごとの直近 Priority (Map: subgroupId → priority) を保持する。Group 横断 (EOR / GROUP_ID_PRESENT) で Map をリセットする。
- 比較は現在のコンテキストの `subgroupPublisherPriority` の代わりに、Map から同一 Subgroup ID の直近 Priority を引く形へ移行する。
- `subgroupPublisherPriority` / `hasPriorSubgroup` の互換フィールドとの関係は実装時に確定する (Map 導入により代替できるか、互換のため残すか)。
- 追加の検証: `checkSubgroupPriorityMismatch` の頻度 (Subgroup ごとの Map 検索) は 8-bit / ビット演算レベルの差分であり、実際のオブジェクト数に対する影響は小さい (Premature Optimization をしない)。
- 変更対象: `src/dataStream.ts` (`FetchObjectContext` / `checkSubgroupPriorityMismatch` / `decodeFetchObjectFields` / `decodeEndOfRange`)、`src/dataStream.fetch.test.ts` (交互出現のテスト追加)、`CHANGES.md`。

## 完了条件

- S1(P100) → S2(P200) → S1(P150) の FETCH 応答で、S1 の直近オブジェクト (P100) との不一致が検出されること ($2.4.2 条件 1)。
- 同一 Group・同一 Subgroup 内の通常の不一致が従来どおり検出されること (回帰ガード)。
- Subgroup が異なる場合の比較は行われないこと (回帰ガード)。
- Group 横断後の同一 Subgroup ID は比較されないこと (Group スコープの維持)。
- Datagram / End of Range を挟んだ交互出現でも追跡が壊れないこと (closed issue 0420 の回帰ガードを維持)。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §2.4.2 (Malformed Tracks / 条件 1)
- 関連: `issues/closed/0420-bug-fetch-priority-mismatch-after-non-subgroup-object.md` (誤検出修正。同 issue の残りの無記録として本 issue を分離)
