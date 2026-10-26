# datagram の上限超過の扱いを決め、送信前の検査を入れる

- Created: 2026-10-11
- Completed: {YYYY-MM-DD}
- Branch: feature/change-datagram-frame-size-limit
- Polished: 2026-10-26
- Reporter: @voluntas

## 目的

moqt-js は送信前に WebTransport の datagram の上限 (`transport.datagrams.maxDatagramSize`) を検査していない。W3C WebTransport の `writeDatagrams` は上限を超えた write を resolve し、UA が黙って捨てる (Chromium の `DatagramUnderlyingSink::SendDatagram` も同じ)。draft-ietf-moq-transport-22 §11.2 も、セッションの最大 datagram サイズを超えた Object は明示の通知なく drop されると定めている。このため現状は、上限を超えた音声 Object が届かなくても `onError` も計器も出ず、落ちたことが利用者から分からない。音声 (1 Object 20 ms / 64 kbps のペイロードは約 160 バイト) では実害は無いが、送信前に検査して扱いを決め、固定する。上限超過は正常な datagram の破棄であり、`onError` にはしない (§11.2 の「明示の通知なく drop」に合わせる)。

## 現状

- `src/session/publish.ts` の `publishSendDatagram` は `encodeObjectDatagram` の結果を `writer.write` に渡すだけで、`transport.datagrams.maxDatagramSize` を読んでいない。上限超過の write は UA が黙って捨て、返値の Promise は resolve する
- `publishSendDatagram` は write の reject を `handleError` へ流すが、W3C WebTransport と Chromium では上限超過は reject しないため、この reject は上限超過以外の失敗 (transport の終了など) の経路である
- W3C WebTransport は `maxDatagramSize` を `WebTransportDatagramDuplexStream` (`transport.datagrams`) に公開している。現在の仕様に `maxDatagramFrameSize` という属性は無い
- 音声の配送 (`AudioPublishOptions.delivery`) は Datagram を選べる。上限超過の扱いが利用者の音の欠落として現れるが、現状はエラー通知も計器も無く、落ちたことが分からない
- §11.2 は、セッションの最大 datagram サイズを超えた Object が明示の通知なく drop されると定めている。これは経路上の各セッションで起こり得る。送り手が書く前に落とすことは妨げない

## 設計方針

1. `publishSendDatagram` で `encodeObjectDatagram` が返した `datagram` の長さ (`datagram.length`) と `session.transport.datagrams.maxDatagramSize` を比べる。超える場合は `writer.write` を呼ばずに落とし、`onError` も呼ばない。`datagram.length` を使うのは、MOQT のヘッダと Object Properties を含めた実際の datagram の大きさで判定するためである
2. `maxDatagramSize` が取れない環境 (属性が無いブラウザ) は従来どおり書き、write の reject は従来どおり `onError` に流す (W3C WebTransport と Chromium では上限超過は reject しない)。TypeScript の DOM 型は `maxDatagramSize: number` としているが、実行時に `undefined` になり得るため `typeof` で確認する。この環境では上限超過を事前に判定できないため、`AudioStats.datagramDroppedFrames` は増えない (UA の挙動に従う)
3. `Publisher.sendDatagram` の戻り値を `Promise<boolean>` にし、上限超過で書かなかった場合だけ `false` を返す。それ以外 (書いた場合と、forwardState / Location Filter / セッション終了で送らなかった場合) は `true` を返す。`src/publisher.ts` の `sendDatagram` の JSDoc と `docs/LOW_LEVEL_API.md` の `sendDatagram()` の説明を更新する
4. 音声の `sendAudioFrameFireAndForget` は、datagram の copy のいずれかが `false` なら `AudioStats.datagramDroppedFrames` を 1 回増やす (同じ Object の冗長度の copy は 1 回と数える)。`src/codec/types.ts` の `AudioStats` のコメントと `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions.audio.delivery` と `AudioStats` の説明を更新する
5. 単体テストで次を固定する
   - `src/session/publish.test.ts` の `createSessionForPublish` に `maxDatagramSize` を足し、上限超過で writer を取得せず write せず、`onError` を呼ばず、`publishSendDatagram` が `false` を返すことを検証する
   - `src/publisher.test.ts` で `PublisherImpl.sendDatagram` が `onSendDatagram` の `false` をそのまま返すことを検証する
   - `src/createMediaPublisher.test.ts` の `createCapturingPublisher` の `sendDatagram` を `Promise<boolean>` にし、`false` のときに `AudioStats.datagramDroppedFrames` が増えることを検証する

## 完了条件

- 上限を超える datagram は `writer.write` を呼ばずに落とし、`onError` を呼ばないこと
- `Publisher.sendDatagram` が、上限超過で書かなかった場合だけ `false` を返し、それ以外は `true` を返すこと
- 上限超過で落とした音声 Object の数が `AudioStats.datagramDroppedFrames` で読めること
- `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions.audio.delivery` と `AudioStats`、`docs/LOW_LEVEL_API.md` の `sendDatagram()` に扱いが書かれていること
- `src/publisher.ts` の `sendDatagram` の JSDoc と `src/codec/types.ts` の `AudioStats` のコメントが更新されていること
- `src/session/publish.test.ts`、`src/publisher.test.ts`、`src/createMediaPublisher.test.ts` の単体テストで上の挙動が固定されていること
- `vp check` / `vp test run` が通ること

## 参照

- `src/session/publish.ts` の `publishSendDatagram` / `src/publisher.ts` の `sendDatagram`
- `src/createMediaPublisher.ts` の `sendAudioFrameFireAndForget` / `src/codec/types.ts` の `AudioDelivery` と `AudioStats`
- `src/session/publish.test.ts` の `createSessionForPublish` / `src/createMediaPublisher.test.ts` の `createCapturingPublisher` / `src/publisher.test.ts` の `onSendDatagram` のフェイク
- `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions.audio.delivery` と `AudioStats` / `docs/LOW_LEVEL_API.md` の `sendDatagram()`
- refs/moq/draft-ietf-moq-transport-22.txt §11.2
- W3C WebTransport の `maxDatagramSize` (https://www.w3.org/TR/webtransport/#dom-webtransportdatagramduplexstream-maxdatagramsize)
- W3C WebTransport の `writeDatagrams` (https://www.w3.org/TR/webtransport/#datagram-writable-procedures)
