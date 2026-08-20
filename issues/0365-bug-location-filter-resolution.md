# Location Filter の解決が仕様と不一致

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-location-filter-resolution
- Polished: 2026-08-20

## 目的

draft-ietf-moq-transport-19 §5.1.2 に基づき、Location Filter の解決ロジックを仕様どおりに修正する。現在は Largest Object フィルタの Object + 1 未適用により通過すべきでないオブジェクトが配信され、Next Group Start フィルタの未配信時 {1, 0} により通過すべきオブジェクト（Group 0）が配信されない。

## 現状

- `src/filter.ts` の `resolveFilter()` は Largest Object（0x2）で `{ start: resolved }` を返し、仕様の「{Largest Object.Group, Largest Object.Object + 1}」の +1 を適用していない。Largest Object と同一 Location のオブジェクトがフィルタを通過してアプリに配信される。具体的な経路: リレーが複数のアップストリーム購読を持つ場合（§10.2.16 の relay の LARGEST_OBJECT 設定規則により複数のアップストリームの Location が統合される）や §5.1.2 の Note（「Note that due to network reordering or prioritization, relays can receive Objects with Locations smaller than Largest Object after the SUBSCRIBE is processed, but these Objects do not pass the Largest Object filter.」）の reordering 状況で、SUBSCRIBE_OK 時点の LARGEST_OBJECT と同一 Location のオブジェクトが購読後に届くと、修正前は通過して配信される（重複配信は複数アップストリーム経由時 / Joining Fetch 併用時に顕在化する）。なお仕様の Note に言うより小さい Location は現状の実装でも既にブロックされており（`objectMatchesFilter()` の `>= start` 比較）、通過しうるのは同一 Location のみである。
- Next Group Start（0x1）は `{ resolved.group + 1n, 0n }` を常に返す。仕様は「If no content has been delivered yet, the filter Start Location is {0, 0}」であり、`largestLocation` が null の場合は {0, 0} になるべき。現在は `resolved = largestLocation ?? { group: 0n, object: 0n }` のフォールバックにより {1, 0} になり、コンテンツ未配信のライブ配信に subscribe すると Group 0 のオブジェクトが全て落ちる。LARGEST_OBJECT はコンテンツ未配信時は SUBSCRIBE_OK から省略される（§10.2.16「If omitted from a message, the sending endpoint has not published or received any Objects in the Track.」）。本ライブラリは SUBSCRIBE_OK でパラメータが無いとき `largestLocation` が null のままなので、SUBSCRIBE_OK 経路では null ⇔ コンテンツ未配信が成立する（REQUEST_UPDATE_OK 経路は LARGEST_OBJECT 省略時に null へ戻さず古い値が保持されるが、本 issue のスコープ外。別 issue で追跡する）。
- `src/filter.test.ts` が誤った挙動を固定している（NextGroupStart 未配信時 Group 1、LargestObject の Location をそのまま start にする）。
- 修正後の Largest Object フィルタ（{G, O+1} から開始）は、Joining Fetch（§10.12.2.1 の「the last Object included in the Joining FETCH response is the Object at the Joining Location」）と組み合わせると「Fetch は {G, O} まで、Subscribe は {G, O+1} から」で連続・非重複（§10.12.2.1 の「contiguous and non-overlapping」）になる。

## 設計方針

- `resolveFilter()` を修正し、仕様どおりにする:
  - Largest Object: `largestLocation` が null なら `{ group: 0n, object: 0n }`、非 null なら `{ group: resolved.group, object: resolved.object + 1n }`
  - Next Group Start: `largestLocation` が null なら `{ group: 0n, object: 0n }`、非 null なら `{ group: resolved.group + 1n, object: 0n }`
  - 実装時は `largestLocation === null` を先に分岐して {0, 0} を返し、フォールバック値（`largestLocation ?? { group: 0n, object: 0n }`）に +1 を適用しないこと（null 時に {0, 1} になる罠を回避する）。
- `src/filter.test.ts` の期待値を仕様どおりに更新し、境界ケースを追加する（更新・維持・新規の内訳は完了条件を参照）。

## 完了条件

- Largest Object フィルタの Start Location が、未配信時 {0, 0}、配信済み時 {Largest Object.Group, Largest Object.Object + 1} になる。
- Next Group Start フィルタが未配信時に {0, 0}、配信済み時に {Largest Object.Group + 1, 0} になる。
- 修正後の挙動を検証するテストがあること:
  - 更新: `resolveFilter: NextGroupStart で LARGEST_OBJECT 未受信時は Group 1`（`src/filter.test.ts`）を未配信時 {0, 0} の期待に更新し（テスト名は「resolveFilter: NextGroupStart で LARGEST_OBJECT 未受信時は {0, 0}」等。実装状態の「未受信」と仕様の「未配信」をテスト名とコメント・期待値の説明で使い分ける）、テスト名・コメントも更新する。
  - 更新: `resolveFilter: LargestObject は LARGEST_OBJECT の Location を start にする`（`src/filter.test.ts`）を {Largest.Group, Largest.Object + 1} の期待に更新し（例: LARGEST_OBJECT = {7, 2} のとき start = {7, 3}）、テスト名・コメントも更新する。
  - コメント修正: 維持する NextGroupStart 配信済み時のテストのコメント（`src/filter.test.ts` の「未受信時は {0, 0} から開始するため Group 1 になる」という誤った記述）を、仕様どおり「未配信時は {0, 0} になる」旨に書き換える。
  - 新規追加: Largest Object = {0, 0} 配信済み時 {0, 1}。あわせて NextGroupStart で largestLocation = {0, 0} のとき {1, 0} になるテストも追加する（未配信時の {0, 0} と start が隣接する境界であり、未配信判定を値（{0, 0} かどうか）で書く誤りを検出できる）。
  - 結合テスト追加（`src/subscriber.test.ts`）: 実フローと同じ順序（SUBSCRIBE 送信時の `setLocationFilter` → SUBSCRIBE_OK 受信時の `setLargestLocation`）で、先に `setLocationFilter({ type: "LargestObject" })` を呼んでから `setLargestLocation({7, 2})` を呼ぶと、`handleObject({7, 2})` がブロックされ `handleObject({7, 3})` が配信されることを検証する。`setLocationFilter` → `handleObject` の再適用経路も同様に検証する（`setLocationFilter` も `resolvedFilterCache` を再計算する）。`handleDatagram` 経路は同一の `resolvedFilterCache` + `objectMatchesFilter` を共有するため対象外とし、ブロックの 1 アサーション（`handleDatagram({7, 2})` がブロックされる）を追加してもよい。
  - 維持: LargestObject 未配信時 {0, 0} と NextGroupStart 配信済み時 {Group + 1, 0}（既存テストでカバー済み。後者はコメントのみ修正）。
- `src/filter.ts` の `resolveFilter()` の JSDoc と `ResolvedFilter` の JSDoc の仕様要約（LargestObject / NextGroupStart の記述）が、修正後の挙動と整合していること。
- `src/session.ts` の `subscribe()` の `options.filter` の説明が、修正後の挙動に合わせて更新されていること: 「LargestObject: 最新のオブジェクトから開始」は「最新オブジェクトの次から開始」に、「NextGroupStart: 次のグループから開始」は「配信済み時は LARGEST_OBJECT の次のグループ、未配信時は {0, 0} から開始」に更新する。
- `CHANGES.md` の `## develop` に本修正（Location Filter の解決）の `[FIX]` エントリが追加されていること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §5.1.2 (Location Filters)（「The filter Start Location is {Largest Object.Group, Largest Object.Object + 1}」「The filter Start Location is {Largest Object.Group + 1, 0}」「If no content has been delivered yet, the filter Start Location is {0, 0}」）
- draft-ietf-moq-transport-19 §10.2.16 (LARGEST_OBJECT Parameter)（「If omitted from a message, the sending endpoint has not published or received any Objects in the Track.」）
- draft-ietf-moq-transport-19 §10.12.2 (Joining Fetches) / §10.12.2.1 (Joining Fetch Range Calculation)（Fetch と Subscribe の連続・非重複）

## 解決方法

未着手。
