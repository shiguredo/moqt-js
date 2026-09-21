# Track Property の VIDEO_CONFIG / AUDIO_CONFIG が初期 configure に反映されず最初の Object が捨てられる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-subscriber-track-property-config
- Polished: 2026-09-21

## 目的

draft-ietf-moq-loc-04 Table 1 は VIDEO_CONFIG (0x0D) と AUDIO_CONFIG (0x0F) の Scope を「Track, Object」とする。closed の `0347-add-loc-track-property-scope.md` で Track Property 経路を追加したが、購読側は初期 configure で Track Property の config を使えていない。canonical 形式 (avc1 / hvc1) の description を Track Property にだけ載せる publisher に対して、最初の Object が復号されずに捨てられる。

## 現状

- `src/createMediaSubscriber.ts` の `start` は `setupDecoders` を `subscribeMediaTracks` より先に呼ぶ (336 行目と 339 行目)
- `setupDecoders` は `LOC.resolveVideoProperties(this.videoSubscriber?.trackProperties, undefined).config` と `LOC.resolveAudioProperties(this.audioSubscriber?.trackProperties, undefined).config` を初期 config として読むが、この時点で `videoSubscriber` / `audioSubscriber` は常に null であり、この分岐はデッドである
- Track Property の config が実際に読まれるのは `handleVideoObject` / `handleAudioObject` の `LOC.resolveVideoProperties` / `resolveAudioProperties` である。これらは Object Property を優先し Track Property をフォールバックするため、Track Property のみの publisher でも config は得られる
- 最初の Object で `isSameAppliedVideoConfig` / `isSameAppliedAudioConfig` が false になり、`reconfigureVideoDecoder` / `reconfigureAudioDecoder` を起動して `videoDecoderConfigured` / `audioDecoderConfigured` を false にしたまま await する。その間と完了後の当該 Object は decode に渡されず捨てられる (両ハンドラは `*Configured` が false の間は早期 return する)
- Object のコールバックは `session.subscribe` の呼び出し時に登録される。SUBSCRIBE_OK の処理は `subscribersByAlias` への登録 → `pendingSubgroupBuffer.notifyAlias` → `pending.resolve` の順に走り、購読確立前に届いてバッファされた Subgroup の Object は配送側の `Promise.race` を挟んで配送されるため、`await session.subscribe(...)` の再開とほぼ同時になり、初期 configure が `decoder.configure` を await する間に配送され得る
- `subscribeMediaTracks` は音声 → 映像の順に subscribe して await する
- 最初の Object がキーフレームだと、次のキーフレームまで映像が出ない
- 初期 configure は Track Property の config 無しで行われるため、codec によっては description が揃わないまま configure される
- devtools の購読は高レベル API を使わない独自実装で、映像経路は Track Property の VIDEO_CONFIG を読まない (`buildVideoDecoderConfig` は Catalog の initData のみ、`parseLocFrameMetadata` は Object Property のみ)。同じ publisher に対して devtools でも復号できない

## 設計方針

- 初期 configure (Track Property の config を反映) を media ごとに行う。`subscribeMediaTracks` の中で、音声・映像それぞれの `await session.subscribe(...)` が返った直後に、その media の `trackProperties` から config を解決して decoder の初期 configure に反映し、`lastAppliedVideoConfig` / `lastAppliedAudioConfig` を更新する。1 つの初期化段にまとめない (音声の適用が映像の SUBSCRIBE_OK 待ちになるため)
- 購読確立前後に届く Object を落とさない。media ごとに「初期 configure 完了まで Object を保留するキュー」を持ち、購読要求を送る前に有効化する (購読確立前の配送もキューに積む)。ハンドラは完了前なら Object をキューへ積んで return し、完了時に到着順で処理する。これにより、購読確立前にバッファから配送される Object も、初期 configure の await 中に届く Object も捨てない
- config の適用に失敗した場合は `onError` を通知し、`lastApplied*` は更新しない (`*Configured` は `setupDecoders` が設定した true を維持する。false にするとハンドラ先頭の早期 return で再試行に到達しない)。解放後の最初の Object では既存の `reconfigure*` 経路が走って config が適用され (その Object は捨てられる)、以降は復号できる
- `setupDecoders` は Catalog から決まる codec / 解像度の解決も担うため、購読前に configure する現状の構造を保つ。`setupDecoders` の `this.videoSubscriber?.trackProperties` / `this.audioSubscriber?.trackProperties` 参照はデッドのため削除する
- devtools の購読は本 issue の対象外とし、同じ問題が残ることを現状に記載しておく (必要なら別 issue とする)
- `src/createMediaSubscriber.test.ts` に、Track Property にのみ config を載せた購読で (1) 初期 configure に config が渡る、(2) 保留キューに積まれた最初の Object が再構成で捨てられず decode に渡る、(3) 同じ config で再構成しない、(4) 初期 configure の適用に失敗した場合も後続の Object で再構成されて復号が続く、を固定するテストを追加する

## 完了条件

- Track Property にのみ config を載せる publisher に対して、最初の Object が decode に渡る (再構成で捨てられない)
- 購読確立前と初期 configure 中に届いた Object が保留キューに積まれ、初期 configure 完了後に到着順で処理される
- 初期 configure で config を適用した後に、同じ config で再構成しない
- 初期 configure の適用に失敗した場合は `onError` が通知され、後続の Object で再試行される
- 上記が `src/createMediaSubscriber.test.ts` で固定される (Node 環境のため WebCodecs の実復号ではなく、configure へ渡る config と decode へ渡る Object を観測する)
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 Table 1 (VIDEO_CONFIG 0x0D / AUDIO_CONFIG 0x0F の Scope は Track, Object)
- draft-ietf-moq-loc-04 §2.3.2.1 (Video Config) / §2.3.3.1 (Audio Config)
- closed `0347-add-loc-track-property-scope.md` (Track Property 経路の追加)
- 関連: `0629-bug-audio-config-late-subscriber.md` (publisher が後着購読者へ Audio Config を送り直さない)

## 解決方法

{未着手}
