# publisher が catalog に targetLatency と renderGroup を載せる

- Created: 2026-09-26
- Completed: {YYYY-MM-DD}
- Branch: feature/add-publisher-target-latency
- Polished: {YYYY-MM-DD}

## 目的

MSF の `targetLatency` は「符号化から表示までの wallclock の差」で、同じ render group の track は同じ値でなければならない (draft-ietf-moq-msf-01 §5.2.8)。`renderGroup` は同じ group の track を同時に描画するための表明である (§5.2.11)。購読側は 0635 で `targetLatency` を表示時刻に使うが、リポジトリ内の publisher (`src/createMediaPublisher.ts` と `devtools/src/hooks/usePublisher.ts`) は catalog にこの 2 つを載せていないため、`targetLatency` を指定した経路を実機で確かめられない (catalog に載っていなければ購読側は遅延を自分で選ぶフォールバックになり、`targetLatency` の経路は単体テストでしか動かない)。

## 現状

- `src/createMediaPublisher.ts` の `createCatalogTracks` は音声と映像の track に `isLive: true` / `role` / codec / bitrate / 解像度などを載せるが、`targetLatency` と `renderGroup` は載せない
- `devtools/src/hooks/usePublisher.ts` の `buildPublisherCatalog` も同じ (`PublisherCatalogOptions` に指定する口が無い)
- `src/msf/types.ts` の `CatalogTrack` には `targetLatency` / `renderGroup` があり、`src/msf/catalogTrackValidation.ts` が値の型と `buffers` との併存禁止を検証しているため、載せた catalog は既存の検証を通る
- 送信側の TIMESTAMP は、映像が `src/mediaClock.ts` の `WallClockMapper`、音声が `LOC.toUnixEpochMicroseconds` で、どちらも壁時計である。`targetLatency` はこの TIMESTAMP からの遅れとして購読側が使う

## 設計方針

- `src/codec/types.ts` の `MediaPublisherOptions` に `targetLatency` (ms) と `renderGroup` (整数) を任意で足し、`createCatalogTracks` が音声と映像の**両方**の track に同じ値を載せる。1 つの値だけを持つことで §5.2.8 の「同じ render group の track は同一の値でなければならない MUST」を構造で守る
- 指定しないときは catalog に載せない (§5.2.8 は「無い場合、購読側が遅延を選んでよい MAY」であるため、載せないことが購読側のフォールバックの経路になる)
- `buffers` は出していないため §5.2.8 の「`buffers` と併存しない MUST NOT」には抵触しない。併せて `targetLatency` と `buffers` を同時に指定できないようにオプションの型で表す (将来 `buffers` を足すときのため)
- devtools の publisher は `PublisherCatalogOptions` に同じ 2 つを足し、設定 UI と URL クエリから指定できるようにする (既存の設定の形に合わせる)
- 実機での確認 (購読側が `targetLatency` どおりの時刻に表示するか) は 0636 が持つ。本 issue は「catalog に載る」ところまでとする

## 完了条件

- `createMediaPublisher` が、指定した `targetLatency` (ms) と `renderGroup` を catalog の音声と映像の両方の track に載せる
- devtools の publisher が、設定と URL クエリで指定した同じ 2 つを catalog に載せる
- 指定しないときは catalog に載らない
- テストで catalog の内容を検証する (`buildPublisherCatalog` はブラウザ API に依存しないため単体で検証できる)
- `docs/HIGH_LEVEL_API.md` の publisher のオプションの記載と実装が一致する
- `CHANGES.md` の `## develop` に `[ADD]` を載せる
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.2.8 (targetLatency: 符号化から表示までの wallclock の差 (ms)。isLive が false なら無視する MUST。同じ render group と alternate group の track は同一の値でなければならない MUST。`buffers` と併存しない MUST NOT。無い場合は遅延を選んでよい MAY)
- draft-ietf-moq-msf-01 §5.2.11 (renderGroup: 同じ group の track は同時に描画する SHOULD)
- 0635 (購読側で `targetLatency` を表示時刻に使う実装。catalog に載っていない間はフォールバックの経路になる)
- 0636 (devtools の A/V 同期。実機での確認を持つ)

## 解決方法

{未着手}
