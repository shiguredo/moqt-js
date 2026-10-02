# Largest Object が到着中であり得る前提で実装を確認する

- Created: 2026-10-02
- Completed: 2026-10-03
- Branch: feature/update-largest-object-arriving
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 §3.1.4 は「Largest Object は到着中の Object を指し得る」ことを明確化した。§3.2 は、Largest Object を含む範囲の FETCH はその Object を完全に配送し、残りは利用可能になり次第届けると定める。LARGEST_OBJECT を「確定済みの最終値」として扱っている箇所がないか確認し、コメントに前提を残す。

## 現状

- `src/session/params.ts` の `extractLargestLocation` は SUBSCRIBE_OK (`src/session/bidi.ts` の `bidiReadSubscribeResponse`) と受信 PUBLISH (`src/session/incomingPublish.ts` の `incomingPublishApplyParameters`) の経路で LARGEST_OBJECT (0x09) を取り出す (REQUEST_UPDATE_OK 経路は `src/session/bidi.ts` の `bidiHandleRequestUpdateOk` 内で同形の取り出しを行う)
- `src/subscriber.ts` の `setLargestLocation` は保持のみで再解決しない。明示的な再解決点は `resolveLocationFilter` だけで、SUBSCRIBE_OK 受信時 (`src/session/bidi.ts` の `bidiReadSubscribeResponse`) に一度だけ呼ばれる。REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY / 受信 PUBLISH では `setLargestLocation` のみを呼び、LOCATION_FILTER が設定・更新されるときだけ `setLocationFilter` がその時点の LARGEST_OBJECT で解決する。PUBLISH_STATE_NOTIFY では同じ内容の LOCATION_FILTER が再報告された場合 `isSameLocationFilter` で `setLocationFilter` をスキップし、前進を防ぐ
- `src/fetcher.ts` / `src/session/stream.ts` は Largest Object を保持せず、FETCH_OK の End Location で完結する。終了位置を Largest Object にクランプする処理は無い
- `src/createMediaSubscriber.ts` の `catalogFetchFilter` は LARGEST_OBJECT が不明なときにフィルタを省略し、publisher 側の既定 (Largest Object まで) に委ねる
- Publisher 側の `PublisherImpl.recordLargestLocation` は送信のたびに Largest Object を更新し、REQUEST_OK / PUBLISH_STATE_NOTIFY に載せる
- コメントは v21 §9.20.18 (LARGEST OBJECT Parameter) などを参照している

## 設計方針

- 「Largest Object は後から進み得る」前提を、`extractLargestLocation` / `setLargestLocation` / `resolveLocationFilter` / `recordLargestLocation` の各コメントに明記し、参照を v22 §3.1.4 / §9.20.17 に更新する。あわせて LARGEST OBJECT Parameter の v21 §9.20.18 を参照しているコメントをすべて検索し (`rg "9\.20\.18"` で一覧化。src/ とテストのコメント)、LARGEST_OBJECT に無関係な §9.20.18 参照が無いことを確認して v22 §9.20.17 / §3.1.4 へ更新する
- LARGEST_OBJECT の更新だけでは `resolvedFilterCache` を更新しない (REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY / 受信 PUBLISH で Largest が進んでも) こと、LOCATION_FILTER の設定・更新時のみ最新の LARGEST_OBJECT で解決することの設計が §3.1.4 と整合することを確認する
- Fetch の「Largest Object を完全に配送する」規定は publisher / relay の責務であり、クライアントは FETCH_OK の End Location を信頼する現状のままでよいことを確認し、コメントに残す
- LARGEST_OBJECT を最終値と仮定している箇所が見つかった場合はテストで再現して修正する

## 完了条件

- 各利用箇所の確認結果と前提がコメントに記録され、src/ とテストのコメントに v21 §9.20.18 (LARGEST OBJECT Parameter) の参照が残っていない
- LARGEST_OBJECT の更新が購読開始後に到着するケース (REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY) のテストが維持されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §3.1.4 (Largest Object) / §3.2 (Fetch) / §9.20.17 (LARGEST OBJECT Parameter)
- `src/session/params.ts` の `extractLargestLocation`
- `src/subscriber.ts` の `setLargestLocation` / `resolveLocationFilter` / `setLocationFilter`
- `src/publisher.ts` の `recordLargestLocation` / `getLargestLocation`
- `src/createMediaSubscriber.ts` の `catalogFetchFilter`
- `src/session/bidi.ts` の `bidiReadSubscribeResponse` / `bidiHandleRequestUpdateOk` / `bidiHandlePublishStateNotify` / `respondToPublishRequestUpdate` / `bidiSendPublishStateNotify`
- `src/session/incomingPublish.ts` の `incomingPublishApplyParameters` (受信 PUBLISH 経路)
- `src/fetcher.ts` の `endLocation` / `setFetchOkInfo`

## 解決方法

draft-ietf-moq-transport-22 §3.1.4 / §3.2 / §9.12 / §9.20.17 を正として、Largest Object を「確定済みの最終値」として扱っている箇所が無いことを確認し、前提をコメントに記録した。挙動の変更はない。

### 1. 確認結果

- Largest Object を最終値と仮定している箇所は無かった。`extractLargestLocation` (抽出) / `setLargestLocation` (保持) / `getLargestLocation` (報告) はいずれも値をそのまま扱い、確定値として比較・クランプする処理は無い
- `resolveLocationFilter` は SUBSCRIBE_OK の受信時に 1 回だけ呼ばれ、REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY / 受信 PUBLISH の LARGEST_OBJECT 更新では `setLargestLocation` のみを呼ぶ。LOCATION_FILTER が新たに設定・更新されたときだけ `setLocationFilter` がその時点の LARGEST_OBJECT で解決する。§3.1.4 / §3.3.1 は「相対指定をどの時点の Largest Object で解決するか」を定めないため、この規則が仕様の解釈として妥当であることをコメントに記録した
- `src/fetcher.ts` は Largest Object を保持せず、FETCH_OK の End Location をそのまま採用する。終端を Largest Object でクランプし直す処理は無いままでよい (クランプすると、到着中の Object を指し得る値で配送済みの Object を取りこぼす)。§3.2 の「Largest Object を含む範囲を完全に配送し、残りは利用可能になり次第届ける」は publisher / relay の責務である
- `src/createMediaSubscriber.ts` の `catalogFetchFilter` は、LARGEST_OBJECT が不明な場合にフィルタを省略して publisher 側の既定 (開始位置 {0, 0}、終端 Largest Object) に委ねる現状のままでよいことを記録した

### 2. コメントの追加

- `extractLargestLocation` / `setLargestLocation` / `resolveLocationFilter` (subscriber) / `recordLargestLocation` / `getLargestLocation` (publisher) / `setFetchOkInfo` (fetcher) / `catalogFetchFilter` に、§3.1.4 の「以前より大きい Location の Object の最初のバイトを送受信した時点で進み、到着中の Object を指し得る」という前提と、参照 (§3.1.4 / §9.12 / §9.20.17) を書いた
- publisher は送信の受け付け時に記録するため、記録時点が「最初のバイト」より早いこと、待機中に paused / 購読のクローズ / Subgroup のクローズが起きると書き込みが行われず記録だけが残ることを明記した (受信側は「到着中」と同じ前提で扱い、配送の有無はデータストリーム側で判断する)
- `src/session/bidi.ts` の fill 範囲判定の `@param` を「publisher が記録した最大 Location」に統一した

### 3. 参照とテスト

- `rg "9\.20\.18"` で src/ とテストを確認し、LARGEST OBJECT Parameter を v21 §9.20.18 として引く参照は残っていない (残る §9.20.18 はすべて v22 の FORWARD Parameter)。LARGEST OBJECT の参照は §9.20.17 に更新済みである (前の変更で反映済み)
- LARGEST_OBJECT の更新が購読開始後に到着するケースのテストは維持されている (`bidiRequestUpdateOk.test.ts` の Next Object 前進抑止、`bidiPublishStateNotify.test.ts` の同一フィルタ抑止と変化時反映、`subscriber.test.ts` の SUBSCRIBE_OK 後更新)。§3.1.4 の前提を踏まえてもテストの追加・修正は不要だった

### 4. 検証

`vp check` (1284 files 整形 / 475 files lint・型エラーなし) / `tsc --noEmit` / `vp test run` (198 files / 3565 tests) が通る。`/review-diff-code` を 3 周回し、指摘 (§3.2 の帰属、FETCH_OK End Location は §9.12、記録時点が「最初のバイト」より早いこと、§3.1.4 の引用の条件) はすべて反映した。CHANGES.md の `## develop` の `### misc` に [UPDATE] エントリを追加した。
