# REQUEST_UPDATE 送信時の MAX_FILTER_RANGES 検証がマージ後のフィルタ状態で行われない

- Priority: Medium
- Created: 2026-08-13
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-max-filter-ranges-merged-check
- Polished: 2026-08-16
- Updated: 2026-08-15

## 目的

draft-ietf-moq-transport-19 §10.3.1.6 / §5.1.3 の「MAX_FILTER_RANGES ... limits the total number of Ranges allowed in all Range Filter parameters for a given subscription or fetch」(§10.3.1.6 は "allowed concurrently" と表現) に従い、REQUEST_UPDATE 送信時の MAX_FILTER_RANGES 検証を「マージ後のフィルタ状態 (現在のフィルタ + update)」に対して行う。

## 現状

- `bidiSendRequestUpdate` (`src/session/bidi.ts`) は `validateRangeFilterLimits(options.rangeFilters, ...)` と **update 単体** の Ranges 数のみを検証している。
- 制限対象は「for a given subscription」すなわちマージ後の全 Range 数であり、update 単体の検証では既存フィルタと合算して上限を超える update を送信できてしまう。
- 例: peer MAX_FILTER_RANGES = 3 で、既存フィルタが 2 Range (update と異なるパラメータ型のため置換されない)、update が 2 Range の場合、update 単体では 2 ≤ 3 で通過するが、マージ後は 4 Range となりピアは INVALID_FILTER で拒否する (ローカル検証は通ったのに `update()` がピアからの REQUEST_ERROR で reject する不整合。§10.9.1 により、REQUEST_UPDATE が失敗すると publisher は PUBLISH_DONE (UPDATE_FAILED) で subscription 自体を強制終了するため、実害は subscription の終了にまで及ぶ)。
- SUBSCRIBE 送信時 (`src/session.ts`) は送信時点のフィルタ状態で検証されている (SUBSCRIBE は新規リクエストであり既存フィルタが存在しないため、単体検証 = マージ後検証)。REQUEST_UPDATE のみが既存状態への上書きを持つため非対称。
- 変更対象ファイル: `src/session/bidi.ts` (`bidiSendRequestUpdate`)、`src/subscriber.ts` (`getRangeFilters` の新規追加。マージ処理は `setRangeFilters` のマージロジックを純関数として抽出する)、`src/session/params.ts` (マージ処理の純関数の配置先) / `src/session/params.test.ts` (純関数の単体テスト)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- `bidiSendRequestUpdate` で現在のフィルタ状態 (`subscriber.getRangeFilters()`。現存しないため実装時に新規追加する) と `options.rangeFilters` を削除 / 置換 / 不変のセマンティクス (既存のフィルタ反映処理と同じ規則) でマージし、マージ後の状態に対して `validateRangeFilterLimits` を実行する。
- マージ処理は既存のフィルタ反映ロジック (REQUEST_OK 受信時の `setRangeFilters` 反映) と同一の結果になること。`setRangeFilters` (`src/subscriber.ts`) にマージロジックが既に内包されているため、これを純関数化して検証と反映の両経路から使うことで同一性を構造的に保証する (検証のために `setRangeFilters` を副作用として呼ぶ実装は、`validateRangeFilterLimits` が throw した時点で SubscriberImpl の状態を汚すため不可)。
- 検証の配置は、throw 時に `pendingRequestUpdate` エントリが残らない位置にする (0393 の先例「ガードは `pendingFetch.set` より前に配置し、throw 時に pending エントリが残らないようにする」に倣う。既存の `validateRangeFilterLimits` 呼び出しは既に `pendingRequestUpdate.set` より前にあるため、マージ後検証も同位置に置けばよい)。
- **並行 update (in-flight) の扱い**: per-subscription の `update()` は MAX_REQUEST_UPDATES まで複数 outstanding 可能であり、REQUEST_OK 反映済みフィルタとのマージのみを対象とすると、1 件目の settle を待たずに 2 件目を呼んだ場合の検証は 1 件目を含まない古い状態に対して行われる (検出限界)。扱いは次のいずれかに実装時に確定する:
  - (a) in-flight の update 分をマージに含める (pendingRequestUpdate の保留中 rangeFilters を加算)
  - (b) 並行 update を禁止する (namespace update の `pendingPrefix` 単一スロット制限の先例に倣い、in-flight 中の 2 件目は throw)
- `validateRangeFilterSpecs` (組み合わせ重複・0x29・削除ガード) はマージ後状態ではなく `options.rangeFilters` 単体に対してのままとする (メッセージ内重複の検証のため)。update 単体の `validateRangeFilterLimits` はマージ後検証に置き換わる (マージ後検証が単体検証を包含する)。
- `getRangeFilters()` の公開範囲は `SubscriberImpl` レベルで足りる (`bidiSendRequestUpdate` の引数は `SubscriberImpl`)。公開 API (`Subscriber` インターフェース) への追加はアプリのニーズが確認された場合に別途検討する。

## 完了条件

- REQUEST_UPDATE 送信時に、既存フィルタと update の合算が MAX_FILTER_RANGES を超える場合は送信前に throw すること。
- 合算が上限以内の場合は送信できること。
- 削除 (remove) を含む update は削除後の状態で検証されること。
- 上記を検証するテストがあること (マージ処理の純関数の単体テストと `bidiSendRequestUpdate` の統合テスト)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.3.1.6 (MAX_FILTER_RANGES)
- draft-ietf-moq-transport-19 §5.1.3 (Range Filters / REQUEST_UPDATE の削除・置換・不変)
- 関連: `issues/closed/0400-add-range-filters-subscribe-tracks.md` (validateRangeFilterLimits の導入)
- 関連: `issues/closed/0393-add-range-filters-fetch.md` (validateRangeFilterSpecs の集約と FETCH への適用)

## 解決方法

未着手。
