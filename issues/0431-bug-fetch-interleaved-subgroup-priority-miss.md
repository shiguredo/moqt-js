# Subgroup が交互に出現する FETCH 応答で同一 Subgroup の Priority 不一致を検出できない

- Created: 2026-08-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-fetch-interleaved-subgroup-priority-miss
- Polished: 2026-08-28

## 目的

FETCH 応答のデコードで、Subgroup が交互に出現する場合 (S1 → S2 → S1) に、§2.4.2 条件 1「An Object with a particular Subgroup ID is received, but its Publisher Priority is different from that of the previous Object with the same Subgroup ID.」の検出ができない。比較対象が「直前オブジェクトのコンテキスト」のみのため、交互出現では同一 Subgroup ID の直前オブジェクトを追跡できない。Subgroup ID ごとの直近 Priority を追跡するように拡張する。

## 現状

- `checkSubgroupPriorityMismatch` (`src/dataStream.ts`) は、現在グループ内の直前 1 オブジェクトのコンテキスト (`FetchObjectContext`) の `subgroupPublisherPriority` のみと比較する。
- S1(P100) → S2(P200) → S1(P150) のように Subgroup が交互すると、S1 再出現時のコンテキストは S2 のため `subgroupId === context.subgroupId` が false となり比較されない。影響: 検出漏れのみ (誤検出なし)。不正な Publisher のデータがそのまま配信され、FETCH キャンセル (MalformedTrackError) が発火しない。
- closed issue 0420 の修正 (誤検出修正) 時に、この検出漏れは「従来から存在する既存ギャップ」として記録された (0420 の解決方法参照)。
- §2.4.2 条件 1 の比較対象は「previous Object with the same Subgroup ID」であり、厳密には Subgroup ID ごとの直前オブジェクトを追跡する必要がある。

## 設計方針

- `FetchObjectContext` に optional の `subgroupPriorities?: Map<bigint, number>` を追加し、現在 Group 内の Subgroup ID ごとの直近 Publisher Priority を保持する。既存の literal 構築 (`src/dataStream.prop.ts` / `src/session.ts` の FetchObjectContext リテラル / 各テストのハードコード context) を壊さないため、必須フィールドにはしない。
- 比較は `checkSubgroupPriorityMismatch` で `context.subgroupPriorities?.get(subgroupId)` を引き、同一 Subgroup ID の直近 Priority と現在オブジェクトの Publisher Priority を比較する形へ移行する。Map が空 / 該当キー無しの場合は「same Subgroup ID の previous Object」が存在しないため比較しない。
- Map の更新ポリシー: Subgroup オブジェクトを decode するたびに、解決後の Publisher Priority (PRIORITY_PRESENT 省略時は継承値) で `map.set(subgroupId, priority)` を行う。Datagram オブジェクト (isDatagram=true) は §2.4.2 条件 1 の対象外 (Subgroup に属さない) のため Map を更新しない。
- リセット条件: 以下のいずれかで Map を新しい空 Map に置き換える。
  - `decodeEndOfRange` で `sameGroup = groupId === context.groupId` が false のとき (EOR で Group が変わった場合)。同一 Group EOR では保持する (0420 の `hasPriorSubgroup` と同じ意味論)。
  - `decodeFetchObjectFields` で GROUP_ID_PRESENT により Group が変わったとき (Subgroup オブジェクト / Datagram オブジェクトのいずれでも Group 変更を伴う場合はリセット)。
- 既存の `subgroupPublisherPriority` / `hasPriorSubgroup` は Map の導入で機能的に代替可能だが、`src/dataStream.prop.ts` の PBT リテラルおよび `src/dataStream.fetch.test.ts` / `src/session.test.ts` のハードコード context 互換のため optional のまま残す (削除は破壊的変更となり本 issue のスコープを超える)。
- `checkSubgroupPriorityMismatch` の参照は `context.subgroupPriorities` を優先し、`subgroupPriorities` が undefined の場合は既存の `subgroupPublisherPriority ?? publisherPriority` + `hasPriorSubgroup` 経路に fallback する。これにより、`subgroupPriorities` を持たない既存ハードコード context (PBT / 既存テスト) を渡した場合の動作は変わらず、0420 由来の「同一 Subgroup 内 priority mismatch を検出する」回帰ガードも保持される。
- パフォーマンス: Map lookup は 1 オブジェクトあたり数命令のオーバーヘッドで、FETCH の Object 数に対して支配的にならない (Premature Optimization をしない)。
- 変更対象: `src/dataStream.ts` (`FetchObjectContext` / `checkSubgroupPriorityMismatch` / `decodeFetchObjectFields` / `decodeEndOfRange`)、`src/dataStream.fetch.test.ts` (交互出現のテスト追加、既存 0420 相当テストの回帰ガード)、`CHANGES.md`。互換維持により `src/dataStream.prop.ts` / `src/session.ts` / `src/session.test.ts` の既存 literal 構築は変更しない (回帰確認のみ)。

## 完了条件

- S1(P100) → S2(P200) → S1(P150) の FETCH 応答で、S1 の直近オブジェクト (P100) との不一致が検出されること (§2.4.2 条件 1)。
- 同一 Group・同一 Subgroup 内の通常の不一致が従来どおり検出されること (回帰ガード)。
- Subgroup が異なる場合の比較は行われないこと (S1(P100) → S2(P200) で S2 は S1 の P100 と比較されない。回帰ガード)。
- Group 横断後の同一 Subgroup ID は比較されないこと (S1(G1,P100) → GROUP_ID_PRESENT → S1(G2,P150) で不一致検出しない。Group スコープの維持)。
- 同一 Group 内 EOR を挟んだ交互出現で追跡が維持されること (0420 の回帰ガード。S1(P100) → EOR(同一 Group) → S1(P150) は不一致検出)。
- Datagram を挟んだ同一 Group 内の交互出現で追跡が維持されること (S1(P100) → Datagram(G1,P200) → S1(P150) は S1 の直近 P100 と比較して不一致検出)。
- Datagram が GROUP_ID_PRESENT で Group を変更した後の同一 Subgroup ID オブジェクトが、旧 Group の Priority と比較されないこと (0420 完了条件と同等のガード)。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §2.4.2 (Malformed Tracks / 条件 1)
- 関連: `issues/closed/0420-bug-fetch-priority-mismatch-after-non-subgroup-object.md` (誤検出修正。同 issue の残りの無記録として本 issue を分離)
