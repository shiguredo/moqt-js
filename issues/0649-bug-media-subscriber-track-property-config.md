# Track Property の VIDEO_CONFIG / AUDIO_CONFIG が高レベル API で使われない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-subscriber-track-property-config
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-loc-04 Table 1 は VIDEO_CONFIG (0x0D) と AUDIO_CONFIG (0x0F) の Scope を「Track, Object」とする。closed の `0347-add-loc-track-property-scope.md` で Track Property 経路を追加したが、購読側は初期 configure で Track Property の config を使えていない。canonical 形式 (avc1 / hvc1) の description を Track Property にだけ載せる publisher に対して、最初の Object が復号されずに捨てられる。

## 現状

- `src/createMediaSubscriber.ts` の `start` は `setupDecoders` を `subscribeMediaTracks` より先に呼ぶ
- `setupDecoders` は `LOC.resolveVideoProperties(this.videoSubscriber?.trackProperties, undefined).config` と `LOC.resolveAudioProperties(this.audioSubscriber?.trackProperties, undefined).config` を初期 config として読むが、この時点で `videoSubscriber` / `audioSubscriber` は常に null であり、この分岐はデッドである
- Track Property の config が実際に読まれるのは `handleVideoObject` / `handleAudioObject` の `LOC.resolveVideoProperties` / `resolveAudioProperties` である。これらは Object Property を優先し Track Property をフォールバックするため、Track Property のみの publisher でも config は得られる
- ただし最初の Object で `isSameAppliedVideoConfig` / `isSameAppliedAudioConfig` が false になり、`reconfigureVideoDecoder` / `reconfigureAudioDecoder` を起動して `videoDecoderConfigured` / `audioDecoderConfigured` を false にする。そのため当該 Object は decode されずに捨てられる
- 最初の Object がキーフレームだと、次のキーフレームまで映像が出ない
- 初期 configure は Track Property の config 無しで行われるため、codec によっては description が揃わないまま configure される

## 設計方針

- SUBSCRIBE_OK の Track Properties が手に入った時点 (購読確立後) で Track Property の config を反映してから Object を処理する初期化段を作る。`setupDecoders` は Catalog から決まる codec / 解像度も解決するため、購読前に configure する現状の構造を保つ
- 購読確立後に config を適用したら `lastAppliedVideoConfig` / `lastAppliedAudioConfig` を更新し、直後の Object で `reconfigureVideoDecoder` / `reconfigureAudioDecoder` が再度走らないようにする
- 初期化段の完了を待ってから Object を処理し、最初の Object を捨てない
- `setupDecoders` の `this.videoSubscriber?.trackProperties` / `this.audioSubscriber?.trackProperties` 参照はデッドのため、初期化段へ移すか削除する

## 完了条件

- Track Property にのみ config を載せる publisher に対して、最初の Object から復号できる
- 初期化段で config を適用した後に、同じ config で再構成しない
- `src/createMediaSubscriber.test.ts` で固定される
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-loc-04 Table 1 (VIDEO_CONFIG 0x0D / AUDIO_CONFIG 0x0F の Scope は Track, Object)
- draft-ietf-moq-loc-04 §2.3.2.1 (Video Config) / §2.3.3.1 (Audio Config)
- closed `0347-add-loc-track-property-scope.md` (Track Property 経路の追加)
- 関連: `0629-bug-audio-config-late-subscriber.md` (publisher が後着購読者へ Audio Config を送り直さない)

## 解決方法

{未着手}
