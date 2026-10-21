# subgroup 配送で指定された音声冗長度が黙って無視されるのを直す

- Created: 2026-10-21
- Completed: 2026-10-21
- Branch: feature/fix-audio-demo-hardening
- Polished: {YYYY-MM-DD}

## 目的

`AudioPublishOptions.redundancy` は 1〜3 の整数として検証されるが、送信側で参照するのは
datagram 配送の分岐だけである。subgroup 配送では同じ Object を 1 回しか送らず、指定が黙って
無視される。利用者は冗長化されていると誤解するため、配送方式と冗長度の組み合わせを検証して
エラーにする。

## 現状

- `src/createMedia/settings.ts` は `redundancy` を 1〜3 の整数として検証する
- `src/createMediaPublisher.ts` の `sendAudioFrameFireAndForget` は datagram のときだけ
  copy を複数送り、subgroup では `publisher.sendObject` を 1 回呼ぶだけである
- library の既定は `delivery: "subgroup"` / `redundancy: 1` であり、既定では冗長化のコードが
  一度も走らない
- datagram が使えない接続 (reliable-only) では配送が subgroup に落ちるため、指定が
  datagram でも実際は無視され得る

## 設計方針

- `start()` で実際の配送方式が確定した後、`delivery !== "datagram" && redundancy > 1` の
  ときはエラーにする。エラーメッセージは英語で、実際の配送方式と冗長度を含める
- 冗長化を使いたい場合は datagram 配送を選ぶことを `docs/HIGH_LEVEL_API.md` に書く
- 配送方式の解決は `src/createMediaPublisher.ts` の `resolvedAudio` を使う

## 完了条件

- 単体テストで、datagram + redundancy 2 は成功し、subgroup + redundancy 2 はエラーになること、
  redundancy 1 はどちらの配送でも成功することを固定する
- `docs/HIGH_LEVEL_API.md` に組み合わせの制約を書く
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

subgroup 配送で `redundancy` 2 以上を指定すると、送信回数が増えないまま黙って無視されていた。
`src/createMedia/settings.ts` の `resolveAudioPublishSettings` で配送方式と冗長度の組み合わせを検証し、
`delivery !== "datagram" && redundancy > 1` のときはエラーにするようにした。エラーメッセージは英語で
配送方式と冗長度の実際の値を含める。`src/codec/types.ts` と `docs/HIGH_LEVEL_API.md` の説明も、
subgroup では 2 以上を指定できない旨に更新した。

検証: datagram + 2/3 は成功、subgroup (と delivery 省略) + 2 はエラー、redundancy 1 はどちらでも成功、
範囲外は配送方式に関係なくエラーになることを単体テストで固定した。既存の
createMediaPublisher.test.ts の期待値も新しい制約に合わせた。`vp check` / `tsc --noEmit` /
`vp test run` が通る。
