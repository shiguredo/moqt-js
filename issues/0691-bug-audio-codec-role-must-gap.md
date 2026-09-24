# audio codec を持つ track に §5.2.28 / §5.2.29 の MUST が課されない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-audio-codec-role-must-gap
- Polished: 2026-09-24

## 目的

closed の `0647-bug-catalog-required-validation.md` は role を手掛かりに codec (§5.2.18) / bitrate (§5.2.22) / samplerate (§5.2.28) / channelConfig (§5.2.29) を必須化した。しかし §5.2.28 と §5.2.29 の仕様上の条件は「audio codecs are specified」であり role ではない。draft-ietf-moq-msf-01 §5.2.6 Table 5 には audio 系の role として `audio` のほかに `audiodescription` があり、custom role も許される。`role: "audiodescription"` や role 未指定で `codec: "opus"` を持つ track は samplerate と channelConfig が無くても受理される。受理した track は購読側が samplerate を `DEFAULT_AUDIO_SAMPLE_RATE` (48000)、channelConfig を `DEFAULT_AUDIO_CHANNELS` (2) で補って configure するため、本来の値と違えば誤った設定で復号する。検証の穴が下流の既定値で隠れる経路が残る。

## 現状

- `src/msf/catalogTrackValidation.ts` の `validateRoleSpecificRules` (361-381 行目、JSDoc は 346-360 行目) は 362-364 行目で `track.role !== "video" && track.role !== "audio"` を早期 return する。samplerate (§5.2.28) と channelConfig (§5.2.29) を要求するのは 375-380 行目で、`track.role === "audio"` のときだけである
- 同関数の JSDoc (353-357 行目) は、仕様の条件が「audio codecs are specified」であり role ではないことを認めたうえで、`audiodescription` などへ課さない解釈を採ると明記している
- 呼び出しは `buildValidatedCatalogTrack` (83 行目) の 110 行目 (packaging 別 MUST の後) と、`src/msf/catalogDelta.ts` の `applyCatalogDelta` の clone 合成後 (130 行目) である
- `src/msf/version.ts` の `RESERVED_TRACK_ROLES` (61-72 行目) は `audio` と `audiodescription` の両方を持ち、`TrackRole` (55 行目) は `string` で custom role を許す
- `buildValidatedCatalogTrack` は `codec` を文字列として pick するだけである (`pickOptionalString(obj, "codec", "§5.2.18", ...)` は 241 行目)。codec が audio か video かを判定する箇所は MSF の検証に無い
- audio codec の判定は `src/createMediaSubscriber.ts` の `parseAudioCodec` (229-237 行目) にだけある。`opus` と `mp4a` の接頭辞を見る非 export の関数で、`parseVideoCodec` (242-259 行目) と対になっている
- 購読側は欠けた値を既定値で補う。`src/createMediaSubscriber.ts` の 847 行目 / 890 行目 / 1210 行目は `this.audioTrackInfo.samplerate ?? DEFAULT_AUDIO_SAMPLE_RATE` を使い、893 行目は `resolveAudioChannelCount(this.audioTrackInfo.channelConfig)` を呼ぶ。`src/codec/config.ts` の `DEFAULT_AUDIO_SAMPLE_RATE` (8 行目) は 48000、`resolveAudioChannelCount` (123 行目) は引数が undefined なら `DEFAULT_AUDIO_CHANNELS` (9 行目) の 2 を返す
- 仕様は §5.2.6 Table 5 (888-950 行目) に `video` / `audio` / `audiodescription` / `mediatimeline` / `eventtimeline` / `caption` / `subtitle` / `signlanguage` / `log` / `metrics` を reserved role として挙げ、custom role も許す。§5.2.28 (1205-1211 行目) と §5.2.29 (1212-1219 行目) の条件はどちらも「This property MUST accompany tracks for which audio codecs are specified.」である
- `src/msf.prop.ts` の `catalogTrackArb` (165 行目) は role が `video` / `audio` のときだけ必須フィールドを補う (235-246 行目)。`codec` は role と独立に生成され (176 行目)、`roleArb` (69-80 行目) は Table 5 の全 reserved 値を生成するため、`audiodescription` と audio codec の組み合わせも生成され得る
- `src/msf.test.ts` の「Catalog: role=audio で samplerate が無いと reject (§5.2.28)」(272 行目) と「Catalog: role=audio で channelConfig が無いと reject (§5.2.29)」(293 行目) が role 手掛かりの現状を固定している (どちらも `codec: "opus"` を持つ)
- 0647 の「残した課題」に「role 条件付き MUST は role を手掛かりにするため、`role: "audiodescription"` など audio codec を持ち得る他の role には課さない (仕様の条件は codec)」と記録されている

## 設計方針

- §5.2.28 / §5.2.29 の判定を role から codec に変える。`track.codec` が audio codec と判定できる track に samplerate と channelConfig を必須にする
- audio codec の判定は WebCodecs Codec Registry §3 Audio Codec Registry の codec string (`flac` / `mp3` / `mp4a.*` / `opus` / `vorbis` / `ulaw` / `alaw` / `pcm-*`) の前方一致で行う。`parseAudioCodec` が扱う `opus` / `mp4a` を必ず含める。判定関数 `isAudioCodec(codec: string): boolean` を `src/msf/catalogTrackValidation.ts` に置き、`src/msf.ts` から再輸出して `createMediaSubscriber.ts` の `parseAudioCodec` もこれを使う (判定が 2 か所でずれないようにする)。`src/index.ts` の公開面には追加しない
- §5.2.18 (codec) と §5.2.22 (bitrate) は role ベースの条件を残す。§5.2.22 は「MUST be specified for audio and video tracks」と role を条件にしており、§5.2.28 / §5.2.29 とは条件が違う。§5.2.6 Table 5 の `audiodescription` を §5.2.22 の「audio track」に含めるかは本 issue の対象外とし、現状維持であることを JSDoc に書く
- 後方互換は 2 方向にある。(1) role が `audio` 以外 (`audiodescription` / custom role / role 未指定) で audio codec を持つ track は新たに拒否される。仕様の MUST に合わせる破壊的変更であり、`CHANGES.md` の `## develop` に `[CHANGE]` を追記する。(2) role が `audio` でも codec が audio codec と判定できない文字列の track は samplerate / channelConfig を要求しなくなる (緩和)。判定できない codec は video codec か独自 codec であり `parseAudioCodec` も失敗するため、従来は「必須にして configure で失敗」だったものが「Catalog では受理」に変わる
- エラー文言は変えない。`invalid track '<name>': audio track must include samplerate per §5.2.28` のままにし、0693 が encode 側へ広げるときと同じ文言を共有する
- `src/msf.prop.ts` の `catalogTrackArb` を新しい条件に合わせる。codec が audio codec のときは samplerate と channelConfig を補い、role 依存を外す。`roleArb` は Table 5 の全値のままとし、`audiodescription` と audio codec の組み合わせも生成されるようにする
- `src/msf.test.ts` に、`role: "audiodescription"` + `codec: "opus"` で samplerate / channelConfig が無いときの拒否、role 未指定 + `codec: "opus"` の拒否、role が `audio` で codec が audio codec でないときの受理、delta の clone 合成後も同じ判定になることを追加する
- 0693 (`encodeCatalog` に track 単位の MUST 検証を広げる) と同じ関数を共有するため、実装順は 0693 を先にするか、後から conflict を解消する

## 完了条件

- `track.codec` が audio codec (`flac` / `mp3` / `mp4a.*` / `opus` / `vorbis` / `ulaw` / `alaw` / `pcm-*`) の track に samplerate と channelConfig が必須になる (role に依存しない)
- `role: "audiodescription"` / custom role / role 未指定で `codec: "opus"` を持ち、samplerate または channelConfig が無い Catalog が拒否される
- role が `audio` でも codec が audio codec でなければ §5.2.28 / §5.2.29 を課さない (その track には §5.2.18 / §5.2.22 が従来どおり適用される)
- role が `video` の codec / bitrate 必須 (§5.2.18 / §5.2.22) の挙動が変わらない
- clone 合成後 (`applyCatalogDelta`) も同じ条件で再検証される
- エラー文言が変わらない
- `isAudioCodec` と `parseAudioCodec` の判定が一致する (audio codec は両方成功し、video codec は両方失敗する)
- `CHANGES.md` の `## develop` に `[CHANGE]` が追記されている
- `src/msf.prop.ts` の round-trip PBT が通る
- `src/msf.test.ts` の既存テストが新しい期待値に更新され、追加テストが通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.2.28 (audio sample rate) / §5.2.29 (channel configuration)。条件は「This property MUST accompany tracks for which audio codecs are specified.」であり、本文は `refs/moq/draft-ietf-moq-msf-01.txt` の 1205-1221 行目
- draft-ietf-moq-msf-01 §5.2.6 Table 5 (reserved track roles。audio 系は `audio` と `audiodescription`、custom role も許容)。同 888-956 行目
- draft-ietf-moq-msf-01 §5.2.18 (codec。条件は「tracks which have an inherent codec associated with them」) / §5.2.22 (bitrate。条件は「audio and video tracks」)。同 1110-1128 行目 / 1149-1156 行目
- W3C WebCodecs Codec Registry §3 Audio Codec Registry (audio codec の codec string 一覧。https://w3c.github.io/webcodecs/codec_registry.html#audio-codec-registry)
- closed `0647-bug-catalog-required-validation.md` (role 手掛かりの判定を導入。残した課題に本件がある)
- 0693 (`encodeCatalog` に同じ検証を広げる。`validateRoleSpecificRules` を共有する)

## 解決方法

{未着手}
