# devtools の映像購読が Track Property の VIDEO_CONFIG を読まない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-track-property-video-config
- Polished: 2026-10-26

## 目的

closed の `0649-bug-media-subscriber-track-property-config.md` は高レベル API の購読側だけを直し、devtools の独自購読実装は対象外とした。devtools の映像経路は Catalog の initData で一度 configure するだけで、Track Property (SUBSCRIBE_OK) の VIDEO_CONFIG を参照しない。canonical 形式 (avc1 / hvc1) の description を Track Property にだけ載せる publisher に対して、高レベル API では復号できるのに devtools では復号できない経路が残る。音声経路は既に `trackProperties` を参照しており、映像経路だけが非対称である。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `buildVideoDecoderConfig` は Catalog の `codec` / `width` / `height` と `resolveInitData(catalog, videoTrack)` だけから `VideoDecoderConfig` を組み立てる。`trackProperties` を引数に取らず参照もしない
- 呼び出しは `startSubscribing` の中で 1 回だけで、`buildVideoDecoderConfig(...)` → `await decoderInstance.configure(decoderConfig)` → `instance.decoderConfigured.value = true` → `await session.subscribe(...)` の順である。configure の時点では SUBSCRIBE_OK の Track Properties が存在しない
- `handleObject` は `buildVideoChunkPlan(instance.subscriber.value?.trackProperties, obj)` の結果で `EncodedVideoChunk` を作り、`decoderInstance.decode(chunk)` を呼ぶ。VIDEO_CONFIG の変化を見て configure をやり直す経路が無い。映像経路の `configure` 呼び出しは `startSubscribing` の 1 箇所のみである
- 音声経路は `handleAudioObject` が `LOC.resolveAudioProperties(current.audioSubscriber.value?.trackProperties, obj.properties)` を呼び、`requiresAudioSpecificConfig(audioCodec)` のときに config が変わったときだけ `audioDecoderInstance.configure(...)` をやり直す。`AUDIO_CONFIG` は Track Property からも解決される
- `buildVideoChunkPlan` は `trackProperties` を取り、Object に Properties がある場合に `LOC.resolveVideoProperties(trackProperties, obj.properties)` を呼ぶ。`LOC.resolveVideoProperties` は TIMESTAMP / VIDEO_FRAME_MARKING を Object Property からのみ取り、Track Property からは TIMESCALE と VIDEO_CONFIG を取る (`src/loc.ts` の `extractLocProperties`、`resolveVideoProperties`、draft-ietf-moq-loc-04 Table 1)。そのため `buildVideoChunkPlan` は Track Property の TIMESCALE を timestamp の解釈に使うが、VIDEO_CONFIG は返さないので configure には使われない。キーフレーム判定は Object Property の VIDEO_FRAME_MARKING と Object ID だけで決まる
- `Subscriber.trackProperties` は `src/subscriber.ts` が保持し、devtools は `subscriberInstance.trackProperties` として参照できる。既存の参照は、映像の `buildVideoChunkPlan` と `recordVideoReceived` が TIMESCALE を、音声の `handleAudioObject` が AUDIO_CONFIG を、`supportsDynamicGroups` が DYNAMIC_GROUPS を参照している。映像の configure は参照していない
- `devtools/src/signals/subscriber.ts` の `SubscriberInstance` に `trackProperties` フィールドは無く、`subscriber` signal 経由で `Subscriber` を保持する形である
- 関連する issue は closed の 0678 (devtools 本体の Worker モード映像エンコーダのバックプレッシャ) と closed の 0677 (ライブラリ側映像デコーダの恒久エラーでの reset ループ) で、どちらも publisher 側または reset の話であり、本件の購読経路とは別である

## 設計方針

- 映像の Object 処理で Track Property の VIDEO_CONFIG を参照し、値が変わったら configure をやり直す。音声経路の `handleAudioObject` と同じ形にする
  - `handleObject` で `LOC.resolveVideoProperties(instance.subscriber.value?.trackProperties, obj.properties)` を呼び、`config` が直前の適用値と異なる場合に `decoderInstance.configure({ ...catalogDerivedConfig, description: new Uint8Array(config) })` を await してから、同じ Object の `decode` に進む
  - Catalog 由来の `VideoDecoderConfig` はフックのスコープの ref に保持し、購読開始時に `buildVideoDecoderConfig` の結果を設定する。description だけを差し替える
  - `appliedVideoConfig` はフックのスコープの ref に保持し、購読開始時に初期 configure で渡した description (Catalog の initData がある場合は `Uint8Array` に変換した値) を設定する。購読を開始するたびにリセットする
  - Object Property の VIDEO_CONFIG が優先され、Track Property はフォールバックになる (`resolveVideoProperties` の既存規則)。これにより VIDEO_CONFIG を Object にだけ載せる publisher でも再 configure が効くようになる
- `session.subscribe` の解決直後にも Track Property の config を適用する。Object のコールバックは `session.subscribe` の呼び出し時に登録されるため、`instance.subscriber.value` の代入より前に届いた Object では `trackProperties` が未設定になる。初期適用の完了を表す Promise を購読要求の前に用意し、`handleObject` は decode の前にその Promise を await する。`instance.subscriber.value` は初期適用の前に代入し、初期適用は `subscriberInstance.trackProperties` から config を解決して行う。これにより、`instance.subscriber.value` の代入前に届いた Object も、Track Property の config が適用されてから decode される
  - 初期適用の Promise は、購読の失敗・中断時も `finally` で resolve し、待機中の `handleObject` を解放する
- `buildVideoDecoderConfig` のシグネチャは変えない。configure の時点では Track Properties が存在しないため、引数を足しても初期 configure では使えない。Track Property の反映は上記 2 つの適用経路 (subscribe 直後と Object 処理) に置く
- 購読確立前の Object は、初期 config の適用 Promise を await してから decode する。保留キューは持たない。Object は既存の `chainRef` の Promise チェーン上で待つ。`handleObject` は既に `chainRef` の Promise チェーンで直列化されており、初期適用と reconfigure が並行しない
- `buildVideoChunkPlan` は変更しない。TIMESTAMP と VIDEO_FRAME_MARKING は Object のみ、TIMESCALE は Track, Object であり、Track Property の TIMESCALE は既に `buildVideoChunkPlan` が参照している。VIDEO_CONFIG は `buildVideoChunkPlan` では使わず、`handleObject` で `resolveVideoProperties` を呼んで解決する
- AUDIO_CONFIG は音声経路が既に `trackProperties` を渡しているため対象外とし、映像経路との非対称の解消だけを行う
- 初期適用に失敗した場合は `appliedVideoConfig` を更新せず、`instance.decodeErrors` を増やし、`handleObject` が同じ Object の decode 前に再試行する。Object ごとの適用に失敗した場合は `instance.decodeErrors` を増やし、その Object の decode を諦めて次の Object で再試行できるようにする (音声経路と同じ扱い)。`console.error` の文言は英語にする規約に従う
- config の解決と適用の判断は `handleObject` が呼ぶ関数として切り出し、`devtools/src/hooks/useSubscriber.test.ts` で直接固定できるようにする。configure / decode の順序は、呼び出しを記録する `DecoderWrapper` の派生 (既存の `RecordingDecoderWrapper` と同じ形) で観測する
- `devtools/src/hooks/useSubscriber.test.ts` に、Track Property にのみ VIDEO_CONFIG を載せた購読で (1) 最初の Object の decode 前に description つきの configure が走る、(2) 同じ config では再 configure しない、(3) Object Property の VIDEO_CONFIG が Track Property より優先される、を固定するテストを追加する。あわせて、`instance.subscriber.value` の代入前に届いた Object が初期適用の完了を待ってから decode されることと、適用失敗時に `instance.decodeErrors` を増やして次の Object で再試行されることを固定する

## 完了条件

- Track Property (SUBSCRIBE_OK) にのみ VIDEO_CONFIG を載せる publisher に対して、devtools の映像 decoder が description つきで configure され、最初の Object が decode に渡る
- SUBSCRIBE の解決直後に Track Property の config が適用され、`instance.subscriber.value` の代入前に届いた Object も、初期適用の完了を待ってから正しい description で復号される
- Object Property に VIDEO_CONFIG が無い Object でも Track Property の値が使われる
- Object Property に VIDEO_CONFIG がある場合は Object Property が優先される
- 直前と同じ config では configure をやり直さない
- 初期適用に失敗した場合は `appliedVideoConfig` を更新せず、`instance.decodeErrors` を増やし、`handleObject` が同じ Object の decode 前に再試行する。Object ごとの適用に失敗した場合は `instance.decodeErrors` を増やし、その Object の decode を諦めて次の Object で再試行される
- Track Property / Object Property のどちらにも VIDEO_CONFIG が無い場合は、従来どおり Catalog の initData だけで configure される
- `buildVideoChunkPlan` とキーフレーム判定の挙動が変わらない
- `devtools/src/hooks/useSubscriber.test.ts` に上記を固定するテストが追加されている
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 Table 1 (VIDEO_CONFIG 0x0D / AUDIO_CONFIG 0x0F の Scope は Track, Object。TIMESTAMP / VIDEO_FRAME_MARKING は Object のみ、TIMESCALE は Track, Object) / §2.3.2.1 (Video Config) / §2.3.3.1 (Audio Config) / §2.3.1.2 (Timescale)。`refs/moq/draft-ietf-moq-loc-04.txt`
- draft-ietf-moq-transport-22 §9.7 (SUBSCRIBE_OK) / §10 (MOQT Properties)
- closed `0649-bug-media-subscriber-track-property-config.md` (高レベル API 側の修正。devtools は対象外と明記されている)
- closed 0677 (ライブラリ側映像デコーダの reset ループ) / closed 0678 (devtools の映像エンコーダのバックプレッシャ。publisher 側)
- 高レベル API の `src/createMediaSubscriber.ts` の `applyInitialVideoConfig` / `releasePendingVideoObjects` (購読確立前の Object を保留する実装の参考)

## 解決方法

{未着手}
