# fill の統計計上区分を購読配送と区別する

- Created: 2026-09-05
- Completed: 2026-09-14
- Branch: feature/update-fill-stats-classification
- Polished: {YYYY-MM-DD}
- Updated: 2026-09-05

## 目的

fill fetch ストリーム経由のオブジェクトが通常 FETCH と同じ fetch 側統計に計上されており、fill と通常 FETCH を区別できない。fillDelivered 導入後の受信経路分離に合わせて統計分類も整理する。

## 現状

- incomingProcessFetchObjects (`src/session/incoming.ts`) は fill fetch ストリームのオブジェクトも fetch 側統計に計上する。
- ソースコードに「購読配送との区別は別途整理する」という残課題の注記がある。
- SessionImpl の統計 (`src/session.ts` の statsObjectsReceivedViaFetch 等) には fill 専用の区分が無い。

## 設計方針

- 受信経路の区別 (fillDelivered) と統計の区別を一致させる。
- fill は仕様 (§5.1.2) 上 subscription-delivered とは別概念のため、原則として独立区分または fetch 側の内訳とする。購読側合算は採用しない。fill 範囲と subscription の Location Filter が重なる both の場合 (§5.1.3) の計上ルール (二重計上 / fill 優先 / 購読優先) も本 issue で定義する。
- 通常 FETCH の計上は変えない。

## 完了条件

- fill 経由と通常 FETCH / 購読経由の計上が区別されるテストがあること。
- `CHANGES.md` の `## develop` に `[UPDATE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.2 (Location Filters: subscription-delivered / fill-delivered)
- draft-ietf-moq-transport-20 §5.1.3 (Fill Semantics)
- 関連: `issues/closed/0459-draft-20-handle-fill-vs-subscription-delivery.md` の後続 (fillDelivered 導入済み。本 issue は統計分類を扱う)。並列の後続として `issues/0462-add-fill-failure-notification.md` (失敗通知) があり、スコープは重ならない

## 解決方法

実装した。issue の参照は draft-20 の節番号だが、現在の一次資料 draft-ietf-moq-transport-21 では §3.4 (Fill Semantics) に対応するため、実装とコメントは draft-21 の節番号に合わせている。

### 区分の決定

「独立区分」を採用した。`SessionStatistics` に `objectsReceivedViaFill` / `bytesReceivedViaFill` を追加し、`incomingProcessFetchObjects` に `viaFill` を渡して計上先を切り替える。`incomingProcessFetchObjects` は `SessionImpl.processFetchObjects` (通常 FETCH) と `SessionImpl.handleFillFetchStream` (fill) の 2 箇所から呼ばれるため、呼び出し元が受信経路を知っている。

「fetch 側の内訳」を採らなかった理由は、内訳にすると `objectsReceivedViaFetch` が fill を含むのか含まないのかが API 利用者に伝わりにくく、配送経路の区別 (`MoqtObject.fillDelivered`) と統計区分が一致しないためである。この結果 `objectsReceivedViaFetch` / `bytesReceivedViaFetch` は通常 FETCH のみを数えるようになり、fill を使う場合だけ値が減る (fill を使わない場合は従来と同値)。購読側への合算は行わない。

### both の場合の計上ルール

§3.4 の "When the fill range overlaps the subscription's Location filter, an object can be both fill-delivered and subscription-delivered." に該当する Object は、publisher が fill fetch ストリームと Subgroup / Datagram の両方で送る。受信側は受信したストリームの種別どおりに 1 回ずつ計上する (二重計上でも fill 優先でも購読優先でもなく、経路ごとの独立計上)。同じ Location が 2 度届けば 2 回計上されるが、これは実際に 2 回受信していることを正しく表す。

### テスト

`src/session.test.ts` に 3 件追加した。

- fill fetch ストリームのオブジェクトは fill 側にのみ計上すること (fetch 側 / subscribe 側は 0)
- 通常 FETCH のオブジェクトは fetch 側にのみ計上し fill 側は 0 であること (回帰ガード)
- fill と subscription の両経路で届いたオブジェクトは経路ごとに 1 回ずつ計上すること

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,117 テスト全通過
- `CHANGES.md` の `## develop` に `[UPDATE]` を追加した
- `docs/LOW_LEVEL_API.md` の `SessionStatistics` 一覧と `processFetchObjects()` の統計記述を更新した
