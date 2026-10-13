# audio codec を持つ track に §5.2.28 / §5.2.29 の MUST が課されない

- Created: 2026-09-24
- Completed: 2026-10-14
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
- 仕様は §5.2.6 Table 5 (888-956 行目) に `video` / `audio` / `audiodescription` / `mediatimeline` / `eventtimeline` / `caption` / `subtitle` / `signlanguage` / `log` / `metrics` を reserved role として挙げ、custom role も許す。§5.2.28 (1205-1211 行目) と §5.2.29 (1212-1221 行目) の条件はどちらも「This property MUST accompany tracks for which audio codecs are specified.」である
- `src/msf.prop.ts` の `catalogTrackArb` (165 行目) は role が `video` / `audio` のときだけ必須フィールドを補う (235-246 行目)。`codec` は role と独立に生成され (176 行目)、`roleArb` (69-80 行目) は Table 5 の全 reserved 値を生成するため、`audiodescription` と audio codec の組み合わせも生成され得る
- `src/msf.test.ts` の「Catalog: role=audio で samplerate が無いと reject (§5.2.28)」(272 行目) と「Catalog: role=audio で channelConfig が無いと reject (§5.2.29)」(293 行目) が role 手掛かりの現状を固定している (どちらも `codec: "opus"` を持つ)
- 0647 の「残した課題」に「role 条件付き MUST は role を手掛かりにするため、`role: "audiodescription"` など audio codec を持ち得る他の role には課さない (仕様の条件は codec)」と記録されている

## 設計方針

- §5.2.28 / §5.2.29 の判定を role から codec に変える。`track.codec` が audio codec と判定できる track に samplerate と channelConfig を必須にする
- audio codec の判定は WebCodecs Codec Registry §3 Audio Codec Registry の codec string (`flac` / `mp3` / `mp4a.*` / `opus` / `vorbis` / `ulaw` / `alaw` / `pcm-*`) の前方一致で行う。判定関数 `isAudioCodec(codec: string): boolean` を `src/msf/catalogTrackValidation.ts` に置き、`src/msf.ts` から再輸出する。`src/index.ts` の公開面には追加しない。`createMediaSubscriber.ts` の `parseAudioCodec` は `AudioCodecType` (`opus` / `aac`) へ写す関数であり対象が違うため共有せず、`isAudioCodec` が `parseAudioCodec` の接頭辞 (`opus` / `mp4a`) を必ず含むことをテストで固定する
- `parseAudioCodec` の対応コーデックを広げることは本 issue の対象外とする。`isAudioCodec` が広い判定になるため、`flac` などの track は Catalog では受理されるが高レベル API の購読では `parseAudioCodec` が `unsupported audio codec` で失敗する。検証 (Catalog の MUST) と購読 (WebCodecs の対応コーデック) は別の関心事であり、対応コーデックの拡大は別 issue とする
- §5.2.18 (codec) と §5.2.22 (bitrate) は role ベースの条件を残す。§5.2.22 は「MUST be specified for audio and video tracks」と role を条件にしており、§5.2.28 / §5.2.29 とは条件が違う。§5.2.6 Table 5 の `audiodescription` を §5.2.22 の「audio track」に含めるかは本 issue の対象外とし、現状維持であることを JSDoc に書く
- 後方互換は 2 方向にある。(1) role が `audio` 以外 (`audiodescription` / custom role / role 未指定) で audio codec を持つ track は新たに拒否される。仕様の MUST に合わせる破壊的変更であり、`CHANGES.md` の `## develop` に `[CHANGE]` を追記する。(2) role が `audio` でも codec が audio codec と判定できない文字列の track は samplerate / channelConfig を要求しなくなる (緩和)。判定できない codec は video codec か独自 codec であり、購読側の `parseAudioCodec` (229-237 行目) も解釈できず `unsupported audio codec` で失敗する値である
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
- `isAudioCodec` が WebCodecs Codec Registry §3 Audio Codec Registry の audio codec string を受理し、`parseAudioCodec` が扱う `opus` / `mp4a` を含む (テストで固定する)
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

- `src/msf/catalogTrackValidation.ts` に `isAudioCodec(codec)` を追加した。WebCodecs Codec Registry §3 Audio Codec Registry の codec string (`alaw` / `flac` / `mp3` / `mp4a.*` / `opus` / `pcm-*` / `ulaw` / `vorbis`) の接頭辞で判定する。`mp4a` と `pcm-` は family (`mp4a.40.2` / `pcm-s16`) を表すため接頭辞で判定し、`parseAudioCodec` (`src/createMediaSubscriber.ts`) が `opus` / `mp4a` の接頭辞で扱うのと整合させた。video codec (`av01.*` / `avc1.*` / `hvc1.*` / `vp8` / `vp09.*`) とは接頭辞が重ならない
- §5.2.28 / §5.2.29 の仕様上の条件は「audio codecs are specified」であり role ではないため、`validateRoleSpecificRules` を role 条件付き MUST (§5.2.18 / §5.2.22) だけに絞り、codec 条件の `validateAudioCodecRules` を新設した。呼び出し順は `validatePackagingSpecificRules` → `validateRoleSpecificRules` → `validateAudioCodecRules` とし、role=audio のときの報告順 (codec → bitrate → samplerate → channelConfig) は従来どおりにした。エラー文言は変えていない
- `role: "audiodescription"` (§5.2.6 Table 5 の audio 系) / custom role / role 未指定 の track でも、audio codec を持てば samplerate と channelConfig を必須にした。packaging にも依存しない (moqlog / moqmetrics の track でも audio codec を持てば必須)。逆に role が video / audio のときの codec / bitrate は従来どおり必須である
- `role: "audio"` で audio codec でない codec (custom codec など) を持つ track は samplerate / channelConfig を課さない (従来は role だけで必須にしていたため緩和になる)。§5.2.18 の仕様上の条件も role ではなく「codec を持つ track」だが、video / audio 以外には課さない従来の解釈を維持した
- `src/msf/catalogDelta.ts` の `applyCatalogDelta` は clone 合成後に `validateAudioCodecRules` も呼ぶ (親から codec を継承 / codec を上書きした結果が audio codec なら必須)。合成後の track は型検証を通らないため、`validateAudioCodecRules` の入口で codec が文字列でなければ素通りさせる (型の検証は decode 側の §5.2.18 の責務。ここで TypeError を出すと「検証違反は plain Error」という契約から外れる)
- `src/msf.ts` から `isAudioCodec` を再輸出した。パッケージの公開面 (`src/index.ts`) には含めない (`src/index.ts` は検証ヘルパーを公開しない方針)
- `src/msf.prop.ts` の `catalogTrackArb` は role 条件 (video / audio → codec / bitrate) と codec 条件 (audio codec → samplerate / channelConfig) を分けて補うようにした。codec は role と独立に生成されるため、`codecArb` で video codec / audio codec / custom codec を重み付きで生成し、role 未指定や `audiodescription` と audio codec の組み合わせも PBT で踏むようにした
- テストは §5.2.28 / §5.2.29 の role 非依存の拒否 (audiodescription / custom role / role 未指定 / moqlog)、role=audio でも audio codec でなければ課さない緩和、encode 経路 (§5.2.28 / §5.2.29) の拒否、clone 合成後の拒否、`isAudioCodec` の受理・非受理、報告順を追加した。既存テストの名前とコメントは role 条件と codec 条件を書き分けた (期待値の変更は無い)
- `createMediaPublisher` と devtools の配信経路は元から audio track に samplerate / channelConfig を設定しており変更していない

### 検証

- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` (218 ファイル / 3843 テスト) / `npx vp run e2e-test` (chromium 110 件) が通る
- `/review-diff-code` を 3 周回し、3 周目で致命的 0 件・重要 0 件になった (1〜2 周目の指摘はすべて反映済み)
- `CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」(2026-10-12) に従い更新していない (完了条件の記載はこれより前のものである)。この変更は従来受理していた Catalog を拒否する破壊的変更と、従来拒否していた Catalog を受理する緩和の両方を含む

## 残した課題

- 購読側の対応コーデックは `opus` / `mp4a` のままで、`isAudioCodec` が受理する他の audio codec (`flac` / `vorbis` / `mp3` / `alaw` / `ulaw` / `pcm-*`) は `parseAudioCodec` が `unsupported audio codec` で失敗する。検証は通るが復号できない組み合わせが残る (本 issue の設計方針どおり別 issue とする)
- audio codec の接頭辞の知識が `src/msf/catalogTrackValidation.ts` / `src/createMediaSubscriber.ts` / `devtools/src/utils/codec.ts` の 3 箇所にある (JSDoc で同期先を明記したが、機械的な固定は無い)
- §5.4 の変数置換 (`resolveCatalogVariables`) は置換後に MUST を再検証しない。`codec: "%c%"` が audio codec に解決されると samplerate / channelConfig が無いまま戻る (送信時の `encodeCatalog` は拒否する。open の `0692-bug-catalog-init-ref-substitution-revalidation.md` が扱う)
- `applyCatalogDelta` の add は合成後に再検証しない (wire の add は decode 時に検証済み。手組みの delta のみ)
- `encodeCatalogDelta` は add / clone の track 単位 MUST を検証しない (open の `0849-bug-encode-catalog-delta-content-validation.md` が扱う)
- `devtools/src/hooks/usePublisher.ts` と `devtools/src/hooks/usePublisher.test.ts` のコメントは §5.2.18 / §5.2.22 / §5.2.28 / §5.2.29 を一括りに「audio codec を指定する track に MUST」と書いており、role 条件と codec 条件の区別が反映されていない (本 issue の対象外)
