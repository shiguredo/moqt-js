# devtools の音声 bytesSent が冗長度の分だけ余計に加算されるのを直す

- Created: 2026-10-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-playout-audio-correctness
- Polished: {YYYY-MM-DD}

## 目的

devtools の配信側音声統計 `audioBytesSent` が Object 1 件につき 1 回加算された後、冗長 copy
ごとにも加算されるため、冗長度 2 で 3 倍、冗長度 3 で 4 倍になる。`objectsSent` と
`bytesSent` の関係が壊れ、帯域の見積もりを誤る。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `processAudioFrames` は
  `pub.audioBytesSent.value += chunk.data.length + properties.length` を 1 回行う
- datagram の copy ループの中でも同じ加算をしている
- 冗長度 1 では正しいが、2 以上で過大になる

## 設計方針

- 加算は送った copy ごとの 1 回だけにする (実際に送ったバイト数)
- datagram でない (subgroup) 場合も 1 回になるよう、ループの外の加算を削除する
- 単体テストで、冗長度 1 / 2 / 3 のとき `bytesSent` が
  `(payload + properties) × 冗長度` になることを固定する

## 完了条件

- 冗長度 1 / 2 / 3 の単体テストが通る
- Copy for LLM の JSON の `audio.bytesSent` が実送信バイト数と一致する
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

{対応時に記入}
