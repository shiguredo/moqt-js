# REQUEST_UPDATE 送信時の MAX_FILTER_RANGES 検証がマージ後のフィルタ状態で行われない

- Priority: Medium
- Created: 2026-08-13
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-max-filter-ranges-merged-check
- Polished: {YYYY-MM-DD}
- Updated: 2026-08-15

## 目的

draft-ietf-moq-transport-19 §10.3.1.6 / §5.1.3 の「MAX_FILTER_RANGES ... limits the total number of Ranges allowed in all Range Filter parameters for a given subscription or fetch」に従い、REQUEST_UPDATE 送信時の MAX_FILTER_RANGES 検証を「マージ後のフィルタ状態 (現在のフィルタ + update)」に対して行う。

## 現状

- `bidiSendRequestUpdate` (`src/session/bidi.ts`) は `validateRangeFilterLimits(options.rangeFilters, ...)` と **update 単体** の Ranges 数のみを検証している。
- 制限対象は「for a given subscription」すなわちマージ後の全 Range 数であり、update 単体の検証では既存フィルタと合算して上限を超える update を送信できてしまう。
- 例: peer MAX_FILTER_RANGES = 3 で、既存フィルタが 2 Range、update が 2 Range の場合、update 単体では 2 ≤ 3 で通過するが、マージ後は 4 Range となりピアは INVALID_FILTER で拒否する (ローカル検証は通ったのに `update()` がピアからの REQUEST_ERROR で reject する不整合)。
- SUBSCRIBE 送信時 (`src/session.ts`) は送信時点のフィルタ状態で検証されているため、REQUEST_UPDATE のみが非対称。
- 変更対象ファイル: `src/session/bidi.ts` (`bidiSendRequestUpdate`)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- `bidiSendRequestUpdate` で現在のフィルタ状態 (`subscriber.getRangeFilters()`。現存しないため実装時に新規追加する) と `options.rangeFilters` を削除 / 置換 / 不変のセマンティクス (既存のフィルタ反映処理と同じ規則) でマージし、マージ後の状態に対して `validateRangeFilterLimits` を実行する。
- マージ処理は既存のフィルタ反映ロジック (REQUEST_OK 受信時の反映) と同一の結果になること (検証と反映の乖離を作らない)。

## 完了条件

- REQUEST_UPDATE 送信時に、既存フィルタと update の合算が MAX_FILTER_RANGES を超える場合は送信前に throw すること。
- 合算が上限以内の場合は送信できること。
- 削除 (remove) を含む update は削除後の状態で検証されること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.3.1.6 (MAX_FILTER_RANGES)
- draft-ietf-moq-transport-19 §5.1.3 (Range Filters / REQUEST_UPDATE の削除・置換・不変)
- 関連: `issues/closed/0400-add-range-filters-subscribe-tracks.md` (validateRangeFilterLimits の導入)
- 関連: `issues/closed/0393-add-range-filters-fetch.md` (validateRangeFilterSpecs の集約と FETCH への適用)

## 解決方法

未着手。
