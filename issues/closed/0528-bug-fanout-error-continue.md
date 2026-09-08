# subgroup の fan-out にも通知と継続の防御を入れる

- Created: 2026-09-07
- Completed: 2026-09-08
- Branch: feature/fix-fanout-error-continue
- Polished: 2026-09-08

## 目的

同一 alias の複数購読への subgroup 配送で 1 件目のアプリ例外が残りの配送とストリーム処理を止める。`incomingHandleDatagram` と同様に通知して継続する必要がある。

## 現状

- `src/session/stream.ts` の `processSubgroupObjects` は `subscribers` への配送を捕捉なしで回すため、1 件目のアプリ例外で 2 件目に届かず当該ストリームの処理も中断する。セッションは閉じない。
- `src/session/stream.ts` の `processFetchObjects` は単一の `FetchObjectSink` のみを受け、fan-out ループを持たない。単一 sink の例外伝播は別扱いとする。
- `src/session/incoming.ts` の `incomingHandleDatagram` は通知して継続する対応済み（`0473-bug-datagram-app-error-swallowed`）のため、同一 alias 複数購読の振る舞いが経路間で分かれている。

## 設計方針

1. `processSubgroupObjects` に `incomingHandleDatagram` と同形の防御を入れる。反復前の `slice()` 複製、購読ごとの `try` / `catch`、`handleError` への通知と `Error` 正規化、error コールバック自体の throw の debug 記録と継続、セッションを閉じないことを含む。`stream.ts` の純粋ヘルパーが `handleError` を持たない場合はシグネチャ変更も許す。
2. `processFetchObjects` の単一 sink 例外は fan-out ではないため、購読継続の対象にしない。単一 sink の例外は従来どおり上位へ伝播させる。

## 完了条件

- 同一 alias の複数購読への subgroup 配送で 1 件目のアプリ例外が `handleError` に通知され、残りの購読への配送と同一ストリームの後続処理が継続すること。
- 単一 sink の fetch 配送の振る舞いが変わらないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- `src/session/stream.ts` の `processSubgroupObjects` に購読ごとの `try` / `catch` を追加し、`SubgroupDeliveryHooks` で通知と継続を行う。反復前に `slice()` 複製する
- `src/session/incoming.ts` で本番フックを構築し、`incomingHandleDatagram` と同形の通知・継続・debug 記録にする。fetch 単一経路は対象外とした
- `src/session/stream.test.ts` と `src/session/incoming.test.ts` に通知・継続のテスト 6 件を追加した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 関連

- draft-ietf-moq-transport-20 §5.1（同一 alias の複数購読。通知継続自体は仕様の定めではなく実装選択である）
- `0473-bug-datagram-app-error-swallowed`（datagram の通知継続の先行対応）
