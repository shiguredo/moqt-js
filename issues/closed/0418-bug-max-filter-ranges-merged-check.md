# REQUEST_UPDATE 送信時の MAX_FILTER_RANGES 検証がマージ後のフィルタ状態で行われない

- Priority: Medium
- Created: 2026-08-13
- Completed: 2026-08-25
- Branch: feature/fix-max-filter-ranges-merged-check
- Polished: 2026-08-20
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
- **並行 update (in-flight) の扱い（確定）**: per-subscription の `update()` は MAX_REQUEST_UPDATES まで複数 outstanding 可能であり、既存実装は並行 update を許可している (bidi.ts の outstanding カウントのみ。MAX_REQUEST_UPDATES 超過時のみ throw)。本 issue は **方式 (a) を主案として確定**し、in-flight の update 分もマージに含めて検証する。方式 (b)（並行 update 禁止）は既存の許可挙動を禁止する破壊的変更であり、namespace update の `pendingPrefix` 単一スロット制限 (bidi.ts) は「subscription 状態の単一スロット」という構造的制約に由来するため per-subscription の pendingRequestUpdate（複数 outstanding 可能な構造）にそのまま転用できる根拠がない。方式 (a) の実装時は、in-flight の pendingRequestUpdate が保持する保留中 rangeFilters をマージに含める。マージは「型単位の削除・置換・不変」の規則に従い、単純な Ranges 総数の加算ではないことに注意する (例: 現在 type A 3 Range、in-flight 1 件目が A を 2 Range に置換、2 件目が A を 3 Range に置換のとき、最終マージは 3 Range。加算すると 3+2+3=8 となり過剰検証を誘発する)。in-flight の update は **送信順（`pendingRequestUpdate` の挿入順）で適用**する (§10.9.1「Parameter values from later REQUEST_UPDATE messages override values from earlier ones」)。
- **方式 (a) の過剰検証（設計上の限界）**: 方式 (a) は「in-flight の update がすべて成功する前提」で検証するため、後に REQUEST_ERROR で失敗確定した update の分も一時的に含んだ過剰検証が生じる。失敗確定時は `pendingRequestUpdate` エントリが削除されるため (bidi.ts の `rejectPendingRequestUpdates`)、その後は正しい状態に戻る。この限界は安全側の挙動として許容する。
- **peerMax = 0 のガード**: マージ後検証に置き換える際、ピアの MAX_FILTER_RANGES = 0 (未広告) の場合は §10.3.1.6「the peer MUST NOT send any such filter parameters」により現在のフィルタも空のため、マージ後が空配列になって早期 return で throw しなくなる。削除のみの update も「filter parameter」であり、peerMax = 0 のガードは削除のみの update に対しても維持する (既存の `validateRangeFilterLimits` の `peerMaxFilterRanges === 0` ガードを置き換え後も維持する)。
- `validateRangeFilterSpecs` (組み合わせ重複・0x29・削除ガード) はマージ後状態ではなく `options.rangeFilters` 単体に対してのままとする (メッセージ内重複の検証のため)。update 単体の `validateRangeFilterLimits` はマージ後検証に置き換わる (マージ後検証が単体検証を包含する)。
- `getRangeFilters()` の公開範囲は `SubscriberImpl` レベルで足りる (`bidiSendRequestUpdate` の引数は `SubscriberImpl`)。公開 API (`Subscriber` インターフェース) への追加はアプリのニーズが確認された場合に別途検討する。
- **純関数化の詳細**: `setRangeFilters` のマージロジックを純関数として `src/session/params.ts` に配置する (変更対象ファイル欄と整合。配置先は params.ts に確定する)。マージロジックは private ヘルパー `rangeFilterKey` (`src/subscriber.ts`) に依存するため、キー生成も純関数として共有する (共有しないと検証と反映の両経路が別キーで結果がずれる)。なお `params.ts` への配置は `subscriber → params → session → subscriber` の循環参照になり得る (実行時は `params` の `session` 参照が type-only のため壊れないが、設計意図として留意する)。マージ純関数の配置は、検証と反映の両経路が同一実装を参照することで構造的に保証する。

## 完了条件

- REQUEST_UPDATE 送信時に、既存フィルタと update のマージ後のフィルタ状態が MAX_FILTER_RANGES を超える場合は送信前に throw すること。
- マージ後の状態が上限以内の場合は送信できること。
- in-flight の update がある状態で次の update を送信する場合も、in-flight 分を含むマージ後の状態で検証されること (方式 (a))。
- 削除 (remove) を含む update は削除後の状態で検証されること。
- ピアの MAX_FILTER_RANGES = 0 の場合、削除のみの update を含めて送信前に throw すること (peerMax = 0 ガードの維持)。
- 上記を検証するテストがあること (マージ処理の純関数の単体テストと `bidiSendRequestUpdate` の統合テスト)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.3.1.6 (MAX_FILTER_RANGES)
- draft-ietf-moq-transport-19 §5.1.3 (Range Filters / REQUEST_UPDATE の削除・置換・不変)
- 関連: `issues/closed/0400-add-range-filters-subscribe-tracks.md` (validateRangeFilterLimits の導入)
- 関連: `issues/closed/0393-add-range-filters-fetch.md` (validateRangeFilterSpecs の集約と FETCH への適用)

## 解決方法

- マージ規則を `src/session/params.ts` の純関数 `mergeRangeFilters` (および鍵生成 `rangeFilterKey`) として抽出し、`SubscriberImpl.setRangeFilters` (受信反映) と送信前検証の両経路から参照 (同一実装の共有により結果の一致を構造的に保証)。
- `SubscriberImpl` に `getRangeFilters()` を追加 (内部配列のコピーを返す)。
- `bidiSendRequestUpdate` (`src/session/bidi.ts`): `options.rangeFilters` が非空のとき、`computeMergedRangeFilters` (現在のフィルタ + in-flight の update を送信順で適用 + 今回の update) の結果に対して `validateRangeFilterLimits` を実行し、マージ後の Ranges 数がピアの MAX_FILTER_RANGES を超える場合は throw。throw は pendingRequestUpdate 登録前であり、エントリは残らない。
- 方式 (a) の限界 (in-flight が成功する前提の過剰検証と削除 update による過少検証) はコメントに明記。
- peerMax=0 ガードは `options.rangeFilters` 単体で維持 (削除のみの update も throw)。空配列 (フィルタ指定なし) は従来どおり送信可能。
- テスト: `params.test.ts` に `mergeRangeFilters` の単体テスト (remove / 置換 / 保持 / update 内複数エントリ)、`bidi.test.ts` にマージ後検証の統合テスト (マージ後超過 throw、上限以内、in-flight 反映、送信順適用、削除後検証、peerMax=0 の削除のみ throw と空配列送信可) を追加。
- `CHANGES.md`: `[FIX]` を追記。
