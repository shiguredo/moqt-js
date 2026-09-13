# fill 失敗をアプリに通知する手段を追加する

- Created: 2026-09-05
- Completed: 2026-09-14
- Branch: feature/add-fill-failure-notification
- Polished: {YYYY-MM-DD}
- Updated: 2026-09-05

## 目的

fill fetch ストリームが reset / Malformed Track で失敗しても、購読は継続する一方でアプリへの通知手段が無い。fill が欠けたことをアプリが検知して再取得を判断できるようにする。

## 現状

- SessionImpl の handleFillFetchStream (`src/session.ts`) は FIN 以外の終了 (reset / Malformed Track 検出) で fill 関連付けを消すだけで、購読の error コールバックには通知しない。
- Malformed Track 検出時はデータストリームの打ち切りのみとし、購読の bidi ストリームには触れない実装 (購読継続の根拠は §5.1.3.1。Malformed 自体の扱いは §2.4.2 を参照) のため、失敗は無音になる。
- ソースコードに「エラー通知の扱いも別途整理する」という残課題の注記がある。

## 設計方針

- fill fetch ストリームの reset / cancel は購読に波及させない (§5.1.3.1) ことを維持し、通知手段だけを追加する (§2.4.2 の通知推奨と両立させる)。
- 通知先 (購読の error コールバックの再利用か fill 専用のコールバックか) と通知内容 (Request ID / 失敗理由) を決める。
- FIN による正常完了では通知しない。

## 完了条件

- fill 失敗時にアプリが失敗を検知できるテストがあること。
- FIN 正常完了では通知が飛ばないことを検証していること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.3.1 (Opening and Closing Fill Fetch Streams)
- draft-ietf-moq-transport-20 §2.4.2 (Malformed Tracks。SHOULD deliver an error to the application)
- 関連: `issues/closed/0459-draft-20-handle-fill-vs-subscription-delivery.md` (fillDelivered 導入済み。本 issue はその並列の後続で、失敗通知を扱う。統計分離は 0463 が扱う)

## 解決方法

マージ済み PR #314 で対応した。issue の参照は draft-20 の節番号だが、現在の一次資料 draft-ietf-moq-transport-21 では §3.4 (Fill Semantics) / §3.4.1 (Opening and Closing Fill Fetch Streams) / §12.1 (Malformed Tracks) に対応するため、実装とコメントは draft-21 の節番号に合わせた。

### 通知先の決定

購読の `error` コールバックを再利用せず、`SubscribeCallbacks.fillError` を新設した。§3.4.1 が "Resetting or cancelling a fill fetch stream, by either endpoint, does not affect the subscription, which continues to deliver objects using subscribe subgroups and datagrams." と定めており、購読の `error` は購読の終了を意味するため、購読が継続する fill の失敗を同じコールバックに流すとアプリが購読終了と誤認する。通知内容は失敗理由の `Error` のみとし、fill を特定する Request ID は `handleFillFetchStream` の debug 記録 (`DATA_STREAM_ERROR` の `decoded.requestId`) で追えるようにした。

### 通知する条件

- publisher の reset による失敗: `fillError` を呼ぶ
- FIN による正常完了: 呼ばない
- Malformed Track 検出: 呼ばない。§12.1 は購読自体の cancel を伴い、`cancelMalformedTrackPeers` が購読の `error` コールバックで通知済みのため、`fillError` を重ねると二重通知になる
- セッション終了起源の失敗 (`isSessionClosedError`): 呼ばない。セッション単位の `error` コールバックが通知する

### 実装中に判明した点

`handleFillFetchStream` の sink はアプリの `object` コールバックの throw をそのまま外側の catch に通しており、これを fill ストリーム自体の失敗と誤認して fill 関連付けを消していた。`fillError` の追加でこの誤認が通知として現れるため、sink で受けて `FILL_CALLBACK_ERROR` として debug コールバックに記録し、fill の受信を継続するようにした (subgroup 経路の `SUBGROUP_CALLBACK_ERROR` と同じ扱い)。`fillError` コールバック自身の throw も握り潰し、`FILL_ERROR_CALLBACK_ERROR` として記録する。

### テスト

`src/session.test.ts` に 5 件追加し、`createDataStreamFinContext` にストリーム reset の再現 (`reset`) と debug 記録の採取を追加した。

- reset で `fillError` に通知し、購読終了の通知は出ず、セッションも閉じず、reset 前のオブジェクトは配信されること
- FIN 正常完了では `fillError` を通知しないこと
- Malformed Track は `fillError` ではなく購読の `error` で通知すること
- `fillError` コールバックの throw を握り潰して `FILL_ERROR_CALLBACK_ERROR` に記録すること
- `object` コールバックの throw でも受信を継続し `fillError` を通知しないこと

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,119 テスト全通過
- `CHANGES.md` の `## develop` に `[ADD]` を追加した
