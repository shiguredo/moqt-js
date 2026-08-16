# TRACK_PROPERTY_FILTER とオブジェクトフィルタが異なる SetID の場合に OR 結合が適用されない

- Priority: Medium
- Created: 2026-08-13
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-range-filter-setid-cross-type-or
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §5.1.3 の「All filter parameters with the same SetID value are combined using logical "AND" operations, then all the resulting sets are combined using logical "OR" operations」を、TRACK_PROPERTY_FILTER とオブジェクトフィルタ (SUBGROUP / OBJECTID / PRIORITY / OBJECT_PROPERTY) をまたいで適用する。

## 現状

- `src/filter.ts` の `trackPropertyFiltersMatch` (受信 PUBLISH の Track Properties に対する TRACK_PROPERTY_FILTER 評価) と `rangeFiltersMatch` (オブジェクト評価) は独立しており、受信 PUBLISH 処理 (`src/session.ts`) は track 評価を先に全体判定して不通過なら UNINTERESTED で拒否する。
- 結合規則は SetID 単位であり、種別をまたいで適用される。しかし現状は「track 評価の結果 AND オブジェクト評価の結果」という直列 AND になり、異なる SetID の場合は OR で結合されるべきものが AND 扱いになる。
- 反例: `[{trackProperty, setId:0, 0x30=[1,1]}, {objectId, setId:1, [3,5]}]` の場合、仕様では SetID 0 (trackProperty) OR SetID 1 (objectId) で結合される。track 不通過 (0x30=0) の PUBLISH でも objectId 3-5 を満たすオブジェクトは転送されるべきだが、現状は UNINTERESTED で拒否される。逆に track 通過の PUBLISH のオブジェクトも objectId 3-5 の範囲外なら落とされる。
- 変更対象ファイル: `src/filter.ts` (SetID 別の track 評価結果を返す関数の追加)、`src/subscriber.ts` (SetID 別 track 評価結果の保持とオブジェクト評価への受け渡し)、`src/session.ts` (受信 PUBLISH の受理判定)、`src/filter.test.ts` / `src/session.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- TRACK_PROPERTY_FILTER を SetID ごとに評価する関数 (`evaluateTrackPropertyFiltersBySetId` 相当) を `src/filter.ts` に追加し、`Map<setId, boolean>` を返す (track フィルタが無い SetID はキーに含めない)。
- 受信 PUBLISH 処理の受理判定を「track 評価で通過する SetID がある、または track フィルタを含まない SetID にオブジェクトフィルタがある」場合に受理するよう変更する (すべて不通過なら従来どおり UNINTERESTED)。
- オブジェクト評価 (`rangeFiltersMatch` 相当) は SetID ごとに「track 評価結果 (PUBLISH 時に確定) AND オブジェクトフィルタ結果」を計算し、SetID 間は OR で結合する。
- SetID 別の track 評価結果は受信 PUBLISH 時に確定するため、`SubscriberImpl` に保持してオブジェクト受信経路 (`handleObject` / `handleDatagram`) に受け渡す。

## 完了条件

- TRACK_PROPERTY_FILTER とオブジェクトフィルタが異なる SetID の場合に、いずれか一方を満たすオブジェクトが転送されること (OR 結合)。
- 同一 SetID の場合は AND 結合のままであること。
- track 評価で全 SetID 不通過かつオブジェクトフィルタの SetID が無い場合は UNINTERESTED で拒否されること (既存挙動の維持)。
- 上記を検証するテストがあること (filter.test.ts の単体テストと session.test.ts の統合テスト)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1.3 (Range Filters / SetID の AND / OR 結合 / TRACK_PROPERTY_FILTER)
- draft-ietf-moq-transport-19 §5.1.4 (Combining Filters / Pass = Forward AND Location Filters AND Range Filters)
- 関連: `issues/closed/0385-moqt-draft-19-range-filter-evaluation-logic.md` (Range Filter 評価の導入)

## 解決方法

未着手。

## pending にした理由

- 本 issue の前提 (解釈 A: TRACK_PROPERTY_FILTER とオブジェクトフィルタが異なる SetID の場合に OR 結合される) は、draft-ietf-moq-transport-19 の一次資料から確定できない (polish-issue 本審で検証済み)。
  - §5.1.3 の結合規則「All filter parameters with the same SetID value are combined using logical "AND" operations, then all the resulting sets are combined using logical "OR" operations.」は種別を限定しないが、同じ節の直後の「PUBLISH messages which pass the filter will be forwarded while those which do not pass it will not be forwarded nor will any Objects.」は、track 不通過の PUBLISH のオブジェクト転送を明示的に否定しており、issue の反例 (track 不通過でも objectId 3-5 を満たすオブジェクトは転送されるべき) と直接矛盾する。
  - §5.1.4 の「All filter types are combined using logical "AND" operations ... Pass = Forward AND Location Filters AND Range Filters」も種別間 AND を支持する。
  - moq-wg でもこの節の解釈は未確定であり、明確化作業が進行中 (moq-wg/moq-transport issue #1810「New section on filters hard to process」/ PR #1851「Clarify Range Filters section for readability」)。
- 現行実装 (0385 で確立) は解釈 B (0x29 は PUBLISH ゲート。不通過は UNINTERESTED で拒否) を採用しており、CHANGES.md にも「受信 PUBLISH の Track Properties に対する TRACK_PROPERTY_FILTER 評価を追加し、不通過は UNINTERESTED で拒否する」と記録済み。
- 対応方針: moq-wg の明確化 (issue #1810 / PR #1851 の結果) で解釈 A が確定した場合にのみ、本 issue を reopened にして対応する。解釈 B が確定した場合は本 issue を closed にする。
