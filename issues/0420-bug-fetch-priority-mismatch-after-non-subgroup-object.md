# Datagram / End of Range 直後の同一 Group・同一 Subgroup オブジェクトを Priority 不一致で誤検出する

- Priority: Low
- Created: 2026-08-16
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-fetch-priority-mismatch-after-non-subgroup-object
- Polished: 2026-08-20

## 目的

FETCH 応答のデコードで、前オブジェクトが Subgroup を持たない (Datagram / End of Range) 場合に、同一 Group・同一 Subgroup の後続オブジェクトの Publisher Priority 不一致を誤検出する挙動を修正する。

## 現状

- `src/dataStream.ts` の `decodeFetchObjectFields` は、`FetchObjectContext` の `publisherPriority` を前オブジェクトの値で更新する。
- 前オブジェクトが Datagram の場合、`newContext.publisherPriority` が Datagram の Priority で上書きされる (Subgroup ID は引き継がれる)。そのため Datagram 直後の同一 Group・同一 Subgroup オブジェクトは Datagram の Priority と比較され、Priority が異なると誤検出される。
- 前オブジェクトが End of Range の場合、`decodeEndOfRange` は groupId と objectId を更新し、subgroupId / publisherPriority は旧オブジェクトの値を保持する。End of Range で Group が変わった後に SUBGROUP_SAME + PRIORITY_PRESENT のオブジェクトが続くと、無関係な旧 Group の Priority と比較され誤検出される。
- draft-ietf-moq-transport-19 §2.4.2 条件 1 の比較対象は「previous Object with the same Subgroup ID」であり、Subgroup を持たないオブジェクト (Datagram / End of Range) は比較対象に含まれない。比較対象となるのは直近の同一 Group・同一 Subgroup の Subgroup オブジェクトである (§2.2「The scope of a Subgroup ID is a Group, so Subgroups from different Groups MAY share a Subgroup ID」、§2.2 の Datagram は Subgroup に属さない旨)。なお §11.4.4.2 の prior 定義 (「The Priority from the last actual Object before the End of Range indicator」) は Group を限定しないため、同一 Group 内の EOR では直前の Subgroup オブジェクトとの比較を支持するが、Group 跨ぎの EOR で旧 Group の値と比較しない本 issue の設計は §2.4.2 / §2.2 の解釈による意図的な選択である。
- 誤検出時は対象 FETCH がキャンセルされる。セッション終了ではなくなったため影響は軽減されているが、正当な FETCH が誤ってキャンセルされる。
- Datagram 混在の誤検出は現行挙動としてテストに固定済み (`src/dataStream.fetch.test.ts` の「Datagram 直後の同一 Group・同一 Subgroup の Priority 不一致は検出される (既知の誤検出を固定)」)。
- 変更対象ファイル: `src/dataStream.ts` (`FetchObjectContext` / `decodeFetchObjectFields` / `decodeEndOfRange`)、`src/dataStream.fetch.test.ts` (テスト修正・追加)、`src/session.test.ts` (0386 の統合テストが修正後も通ることの回帰確認)、`CHANGES.md`。

## 設計方針

- Priority 比較を「比較対象の先行 Subgroup オブジェクトが存在する場合」に限定する。比較対象は「同一 Group・同一 Subgroup の直近の Subgroup オブジェクト」である。前オブジェクトが Datagram / End of Range の場合は、その前の Subgroup オブジェクトの Priority と比較する (Datagram / End of Range 自体は比較対象にしない)。
- `FetchObjectContext` の `publisherPriority` は **Subgroup オブジェクトでのみ更新**する。Datagram オブジェクトでは上書きしない (現行の `newContext.publisherPriority` を Datagram の値で更新する挙動を変更する)。これにより、Datagram 直後・Datagram を挟んだ後の Subgroup オブジェクトは、Datagram の Priority ではなく直近の Subgroup オブジェクトの Priority と比較される。
- `FetchObjectContext` に **「現在の Group 内に先行する Subgroup オブジェクトが存在するか」** を保持するフィールド (boolean) を追加する。これは「前オブジェクトが Subgroup を持っていたか」ではない点に注意する:
  - Datagram / End of Range 直後の Subgroup オブジェクトは、前オブジェクトは Subgroup を持たないが、**同一 Group 内の先行 Subgroup オブジェクトが存在すれば**その Priority と比較する (完了条件 3「真の不一致は従来どおり検出」を満たす。例: Subgroup(G1,S0,P100) → Datagram(G1,P200) → Subgroup(G1,S0,P150) は P100 との比較で不一致を検出)。
  - フラグは **Group が変更されたとき (End of Range による Group 変更、または Datagram が自前の GROUP_ID_PRESENT で Group を変更した場合) にリセット**する。新 Group 内で最初の Subgroup オブジェクトの PRIORITY_PRESENT 検証は、同一 Group 内の先行 Subgroup オブジェクトが存在しないため比較しない (比較対象なし)。旧 Group の Priority は新 Group のオブジェクトの比較対象にしない。
- フィールド追加は `FetchObjectContext` の newContext を生成する箇所 (decodeEndOfRange / decodeFetchObjectFields) に波及する。optional フィールドとして追加して互換性を保つ (エンコード側 `encodeFetchObjectFields` や既存のリテラル構築箇所は optional のため変更不要)。
- 既存の誤検出固定テストを、修正後の挙動 (誤検出しない) に書き換える。

## 完了条件

- 同一 Group 内で Datagram を挟んだ後の同一 Subgroup オブジェクトが、Datagram と異なる Priority でも誤検出されないこと (直近の Subgroup オブジェクトとの比較になること)。
- End of Range で Group が変わった後の同一 Subgroup ID オブジェクトが、旧 Group の Priority と比較されないこと。
- 同一 Group・同一 Subgroup 内の真の Priority 不一致 (直近の Subgroup オブジェクトとの比較) は従来どおり検出されること (誤検出の修正で正当な検出を壊さない回帰ガード。Datagram を挟んだ場合も直近の Subgroup オブジェクトとの比較で検出されること)。
- Datagram が自前の Group ID で Group を変更した後の同一 Subgroup ID オブジェクトが、旧 Group の Priority と比較されないこと。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §2.4.2 (Malformed Tracks / 条件 1「An Object with a particular Subgroup ID is received, but its Publisher Priority is different from that of the previous Object with the same Subgroup ID.」)
- draft-ietf-moq-transport-19 §2.2 (Subgroup ID のスコープ「The scope of a Subgroup ID is a Group」、Datagram は Subgroup に属さない)
- draft-ietf-moq-transport-19 §11.4.4 / §11.4.4.1 (Fetch Object Fields / Datagram・End of Range) / §11.4.4.2 (End of Range)
- 関連: `issues/closed/0386-moqt-draft-19-fetch-priority-mismatch-session-close.md`（FETCH の Priority 不一致を FETCH キャンセルで処理した経緯。本 issue はそこから分離された誤検出修正）

## 解決方法

未着手。
