# datagram の上限超過の扱いを決め、送信前の検査を入れる

- Created: 2026-10-11
- Completed: {YYYY-MM-DD}
- Branch: feature/change-datagram-frame-size-limit
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-js は送信前に transport の datagram の上限 (`maxDatagramFrameSize`) を検査しないため、上限を超える Object は `writer.write` の reject としてエラー通知になる。draft-ietf-moq-transport-22 §11.2 はサイズを超えた Object が明示の通知なく drop されることを許しており、エラー通知にすると「Datagram を選んだが 1 件も届かない」状態がエラーとして現れ続ける。音声 (1 Object 20 ms / 64 kbps) では実害は無いが、扱いを決めて固定する。

## 現状

- `src/session/publish.ts` の `publishSendDatagram` は `writer.write` の reject を `handleError` へ流すだけで、事前の大きさの検査をしない
- W3C WebTransport は `maxDatagramFrameSize` を公開しているが、moqt-js は読んでいない
- 音声の配送 (`AudioPublishOptions.delivery`) は Datagram を選べるようになり、上限超過の扱いが利用者に見える (エラー通知か、暗黙の drop か)
- §11.2 の「明示の通知なく drop」は受け手の振る舞いを定めたものであり、送り手が書く前に落とすことは妨げない

## 設計方針

1. 送信前に Object の大きさを transport の上限と比べ、超える場合は書かずに落とす。`onError` にはせず、落とした数を計器に出すかを決める (出す場合は `AudioStats` のどこに置くかを決める)
2. 上限が取れない環境 (属性が無いブラウザ) は従来どおり書き、reject を通知に流す
3. この扱いを `docs/HIGH_LEVEL_API.md` の `AudioPublishOptions.delivery` の説明に書く

## 完了条件

- 上限超過の扱い (暗黙の drop か、エラー通知か) が決まり、実装と docs に書かれていること
- 上限を超える Object を渡したときの挙動が単体テストで固定されていること
- `vp check` / `vp test run` が通ること

## 参照

- `src/session/publish.ts` の `publishSendDatagram` / `src/publisher.ts` の `sendDatagram`
- `src/createMediaPublisher.ts` の `sendAudioFrameFireAndForget` / `src/codec/types.ts` の `AudioDelivery`
- `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions.audio.delivery`
- refs/moq/draft-ietf-moq-transport-22.txt §11.2
- W3C WebTransport の `maxDatagramFrameSize` (https://www.w3.org/TR/webtransport/#dom-webtransport-maxdatagramframesize)
