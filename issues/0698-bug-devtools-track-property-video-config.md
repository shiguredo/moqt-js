# devtools の映像購読が Track Property の VIDEO_CONFIG を読まない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-track-property-video-config
- Polished: 2026-09-24

## 目的

closed の `0649-bug-media-subscriber-track-property-config.md` は高レベル API の購読側だけを直し、devtools の独自購読実装は対象外とした。devtools の映像経路は Catalog の initData で一度 configure するだけで、Track Property (SUBSCRIBE_OK) の VIDEO_CONFIG を参照しない。canonical 形式 (avc1 / hvc1) の description を Track Property にだけ載せる publisher に対して、高レベル API では復号できるのに devtools では復号できない経路が残る。音声経路は既に `trackProperties` を参照しており、映像経路だけが非対称である。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `buildVideoDecoderConfig` (69 行目) は Catalog の `codec` / `width` / `height` と `resolveInitData(catalog, videoTrack)` (84 行目) だけから `VideoDecoderConfig` を組み立てる。`trackProperties` を引数に取らず参照もしない
- 呼び出しは `startSubscribing` の中で 1 回だけで、`const decoderConfig = buildVideoDecoderConfig(...)` (1049 行目) → `await decoderInstance.configure(decoderConfig)` (1052 行目) → `instance.decoderConfigured.value = true` (1066 行目) → `const subscriberInstance = await session.subscribe(...)` (1095 行目) の順である。configure の時点では SUBSCRIBE_OK の Track Properties が存在しない
- 同ファイルの `handleObject` (678 行目) は `buildVideoChunkPlan(obj)` (699 行目) の結果で `EncodedVideoChunk` を作り、そのまま `decoderInstance.decode(chunk)` を呼ぶ (729 行目)。VIDEO_CONFIG の変化を見て configure をやり直す経路が無い (映像経路の `configure` 呼び出しは 1052 行目の 1 箇所のみ)
- 音声経路は `handleAudioObject` が `LOC.resolveAudioProperties(current.audioSubscriber.value?.trackProperties, obj.properties)` を呼び (470-473 行目)、config が変わったときだけ `audioDecoderInstance.configure(...)` をやり直す (481-490 行目)。`AUDIO_CONFIG` は Track Property からも解決される
- `devtools/src/hooks/useSubscriber.ts` の `buildVideoChunkPlan` (128 行目) は `obj.properties` のみを `LOC.decodeVideoProperties` に渡す (135-143 行目)。`LOC.resolveVideoProperties` は TIMESTAMP / VIDEO_FRAME_MARKING を Object Property からのみ取り、Track Property からは TIMESCALE と VIDEO_CONFIG だけを取る (`src/loc.ts` の `extractLocProperties` 711 行目、`resolveVideoProperties` 764 行目、draft-ietf-moq-loc-04 Table 1) ため、キーフレーム判定と timestamp に Track Property は関与しない
- `Subscriber.trackProperties` は `src/subscriber.ts` が保持し (102 行目 / 202 行目)、devtools は `subscriberInstance.trackProperties` として参照できる。既存の参照は `supportsDynamicGroups(subscriberInstance.trackProperties)` (1142 行目) の 1 箇所である
- `devtools/src/signals/subscriber.ts` の `SubscriberInstance` に `trackProperties` フィールドは無く、`subscriber` signal 経由で `Subscriber` を保持する形である
- 関連する open issue は 0678 (devtools 本体の Worker モード映像エンコーダのバックプレッシャ) と 0677 (ライブラリ側映像デコーダの恒久エラーでの reset ループ) で、どちらも publisher 側または reset の話であり、本件の購読経路とは別である

## 設計方針

- 映像の Object 処理で Track Property の VIDEO_CONFIG を参照し、値が変わったら configure をやり直す。音声経路 (470-490 行目) と同じ形にする
  - `handleObject` で `LOC.resolveVideoProperties(instance.subscriber.value?.trackProperties, obj.properties)` を呼び、`config` が直前の適用値と異なる場合に `decoderInstance.configure({ ...catalogDerivedConfig, description: new Uint8Array(config) })` を await してから、同じ Object の `decode` に進む
  - Catalog 由来の `VideoDecoderConfig` は `buildVideoDecoderConfig` の結果をローカルに保持して使い回す。description だけを差し替える
  - Object Property の VIDEO_CONFIG が優先され、Track Property はフォールバックになる (`resolveVideoProperties` の既存規則)。これにより VIDEO_CONFIG を Object にだけ載せる publisher でも再 configure が効くようになる
- `session.subscribe` の解決直後にも Track Property の config を適用する。Object のコールバックは `session.subscribe` の呼び出し時に登録されるため、`instance.subscriber.value` の代入 (1123 行目) より前に届いた Object では `trackProperties` が未設定になる。`subscriberInstance.trackProperties` から config を解決し、Catalog 由来の config と異なれば configure をやり直してから `instance.subscriber.value` を代入する (高レベル API の `applyInitialVideoConfig` と同じ形)
- `buildVideoDecoderConfig` のシグネチャは変えない。configure の時点では Track Properties が存在しないため、引数を足しても初期 configure では使えない。Track Property の反映は上記 2 つの適用経路 (subscribe 直後と Object 処理) に置く
- 保留キューは導入しない。reconfigure は同じ Object の `decode` の前に await するため、最初の Object から正しい description で復号できる。`handleObject` は既に `chainRef` の Promise チェーンで直列化されており (1104 行目)、reconfigure 中の並行 decode は起きない
- `buildVideoChunkPlan` は変更しない。TIMESTAMP と VIDEO_FRAME_MARKING は draft-ietf-moq-loc-04 Table 1 で Scope が Object のみであり、Track Property を参照する意味が無い
- AUDIO_CONFIG は音声経路が既に `trackProperties` を渡しているため対象外とし、映像経路との非対称の解消だけを行う
- 適用に失敗した場合は `appliedVideoConfig` を更新せず、`instance.decodeErrors` を増やして次の Object で再試行できるようにする (音声経路と同じ扱い)。`console.error` の文言は英語にする規約に従う
- `devtools/src/hooks/useSubscriber.test.ts` に、Track Property にのみ VIDEO_CONFIG を載せた購読で (1) 最初の Object の decode 前に description つきの configure が走る、(2) 同じ config では再 configure しない、(3) Object Property の VIDEO_CONFIG が Track Property より優先される、を固定するテストを追加する

## 完了条件

- Track Property (SUBSCRIBE_OK) にのみ VIDEO_CONFIG を載せる publisher に対して、devtools の映像 decoder が description つきで configure され、最初の Object が decode に渡る
- SUBSCRIBE の解決直後に Track Property の config が適用され、`instance.subscriber.value` の代入前に届いた Object も正しい description で復号される
- Object Property に VIDEO_CONFIG が無い Object でも Track Property の値が使われる
- Object Property に VIDEO_CONFIG がある場合は Object Property が優先される
- 直前と同じ config では configure をやり直さない
- Track Property / Object Property のどちらにも VIDEO_CONFIG が無い場合は、従来どおり Catalog の initData だけで configure される
- `buildVideoChunkPlan` とキーフレーム判定の挙動が変わらない
- `devtools/src/hooks/useSubscriber.test.ts` に上記を固定するテストが追加されている
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 Table 1 (VIDEO_CONFIG 0x0D / AUDIO_CONFIG 0x0F の Scope は Track, Object。TIMESTAMP / VIDEO_FRAME_MARKING は Object のみ) / §2.3.2.1 (Video Config) / §2.3.3.1 (Audio Config)。`refs/moq/draft-ietf-moq-loc-04.txt`
- draft-ietf-moq-transport-21 §9.20 (SUBSCRIBE_OK の Track Properties)
- closed `0649-bug-media-subscriber-track-property-config.md` (高レベル API 側の修正。devtools は対象外と明記されている)
- 0677 (ライブラリ側映像デコーダの reset ループ) / 0678 (devtools の映像エンコーダのバックプレッシャ。publisher 側)

## 解決方法

{未着手}
