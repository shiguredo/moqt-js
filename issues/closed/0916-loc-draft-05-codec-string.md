# LOC 05 の CODEC_STRING Property を読み書きする

- Created: 2026-11-03
- Completed: 2026-11-05
- Branch: feature/change-loc-draft-05
- Polished: 2026-11-03

## 目的

draft-ietf-moq-loc-05 §2.3.1.3 は、WebCodecs の codec に対応する UTF-8 の CODEC_STRING (0x11) を追加した。現在の LOC helper は config の description を扱えるが、codec string を取得・生成できない。

## 現状

- `src/loc.ts` の `LOCPropertyId`、`VideoProperties` / `AudioProperties` に CODEC_STRING が無い
- `extractLocProperties` と `resolveVideoProperties` / `resolveAudioProperties` は timestamp / timescale / config などを解決するが、0x11 は抽出しない
- `src/index.ts` が LOC helper を公開している

## 設計方針

- 0x11 の length-prefixed UTF-8 Property を encode / decode する helper と公開型を追加する
- Track / Object それぞれで mutable list と Immutable Properties 内側の両方を検索し、Object 値を優先、無ければ Track 値へフォールバックする。既存 extractLocProperties が Immutable 内側を検索しない動作を新しい CODEC_STRING に引き継がない。decodeProperties の出力では Immutable の property.data は本文のみなので、supportsDynamicGroups と同様に decodeProperties(property.data) で内側を読む。ID + Length 付きの完全ワイヤを要求する decodeImmutableProperties に本文だけを渡さない
- CODEC_STRING を対応済み型として必ず登録し、Value 形式・scope・重複の検証を 0913 / 0914 と共有する。既知型の UTF-8 不正や Type 定義との Length 不整合は MALFORMED_KEY_VALUE、禁止された重複は MalformedTrackError とし、0902 の長さ上限などの優先規則と各受信文脈の終了処理を維持する。LOC の寛容な抽出だけで受信検証を代用しない
- MSF catalog の codec と矛盾した際の新しい優先規則や、Object ごとの無条件 decoder 再構成を推測で追加しない。本 issue は LOC Property の公開・解決までを対象とする

## 完了条件

- ASCII / マルチバイト UTF-8、長さ・チャンク境界、Track / Object の各 scope を検証する
- Track / Object の mutable / Immutable 内側にある CODEC_STRING を解決でき、内外の重複と不正 UTF-8 を適切な受信エラーにする。0x11 を未知型として使う既存テストの入力も変更する
- audio / video 両方で resolve と公開 export を利用できる
- CODEC_STRING が無い既存 Object の処理は変わらない
- 仕様参照を LOC 05 にし、0x11 を別 Property と誤認しない

## 参照

- `refs/moq/draft-ietf-moq-loc-05.txt` §2.3.1.3 / §6.1
- `refs/moq/draft-ietf-moq-transport-23.txt` §8.3 / §8.4 / §10.7
- `src/loc.ts`、`src/properties.ts`、`src/index.ts`、`src/loc.test.ts` / `loc.prop.ts`

## 解決方法

- `src/loc.ts` の `LOCPropertyId` に `CODEC_STRING` (0x11) を追加し、`VideoProperties` / `AudioProperties` に `codecString?: string` を追加した。`encodeVideoProperties` / `encodeAudioProperties` が UTF-8 の length + bytes として書き、`decodeVideoProperties` / `decodeAudioProperties` が読み戻す。
- draft-ietf-moq-loc-05 §2.3.1.3 の CODEC_STRING は Track / Object の両スコープを持つため、`extractLocProperties` で scope に関係なく抽出する。`resolveVideoProperties` / `resolveAudioProperties` は Object 値を優先し、無ければ Track 値へフォールバックする。
- draft-ietf-moq-transport-23 §10.7 に従い、mutable list だけでなく Immutable Properties の内側も検索する。`extractLocProperties` は CODEC_STRING 専用の探索ではなく、扱う全 Property (TIMESTAMP / TIMESCALE / VIDEO_FRAME_MARKING / AUDIO_LEVEL / VIDEO_CONFIG / AUDIO_CONFIG / CODEC_STRING) に同じ 2 パス (mutable list → Immutable 内側) を適用し、mutable list を優先する。`decodeProperties` の出力では Immutable の `property.data` は本文だけなので、内側を `decodeProperties` で読み直す (`supportsDynamicGroups` / `resolveDefaultPublisherPriority` と同じ扱い)。Object 側も `decodeVideoProperties` / `decodeAudioProperties` の寛容経路で同じ 2 パスを使う。
- `src/properties.ts` で CODEC_STRING を対応済み Property として登録した。`SUPPORTED_PROPERTY_TYPES` / `KNOWN_PROPERTY_TYPES` に加え、scope は 0913 の `PROPERTY_SCOPES` (Track / Object 両方) を共有する。重複検証も 0914 の汎用規則に乗る。
- `KNOWN_PROPERTY_TYPES` は MOQT 本体の Property と CODEC_STRING (0x11) のみを含む。CODEC_STRING は Value の内容 (UTF-8) を検証するため既知 Type に含め、TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG など他の LOC Property は既存の寛容な扱いを変えないため含めない (コメントを実装に合わせた)。
- 受信検証として、CODEC_STRING の Value が UTF-8 として不正な場合は §8.3 の serialization 不一致として MALFORMED_KEY_VALUE で拒否する (内部関数 `assertLocCodecStringValue`)。`assertKnownPropertyDataValue` に集約し、外側の KVP 列・`decodeProperties` の Immutable 内側走査・`decodeImmutableProperties` のすべてで同じ規則を使う。Object 側の `assertKnownPropertyValueInObjectProperties` も同じ検証を呼ぶ。Immutable 内側の検証は Object 受信経路では `assertPropertyScopesInObjectProperties` 経由の `decodeProperties` が担う (`decodeImmutableProperties` は本番経路から呼ばれないテスト向け API)。Length の切り詰めも既知 Type の長さ不一致として MALFORMED_KEY_VALUE になる。
- CODEC_STRING を UTF-8 文字列として読む `TextDecoder` の実装を `src/properties.ts` に集約した。設定は `fatal: true` と `ignoreBOM: true` で、先頭 BOM (U+FEFF) は Value の一部として保持し、encode / decode の往復で一致させる。寛容な読み取りは `decodeLocCodecStringValue`、受信検証は `assertLocCodecStringValue` が担い、`src/loc.ts` は `decodeLocCodecStringValue` を import する。
- 送信側の `encodeVideoProperties` / `encodeAudioProperties` / `buildPublishTrackProperties` は、空の `codecString` と孤立サロゲートを含む `codecString` を拒否する (`assertLocCodecStringForSend`)。空文字列は WebCodecs の codec 文字列として無効であり、孤立サロゲートは `TextEncoder` が U+FFFD に置換して送信値が変わるためである。受信側は draft-ietf-moq-loc-05 §2.3.1.3 の Length が Varies で 0 を禁止していないため、長さ 0 の Value を空文字列として受理する。
- 抽出処理の「mutable list 優先」は検証前の寛容な抽出の内部規則であり、受信経路では draft-ietf-moq-transport-23 §8.4 の重複禁止により malformed になることを JSDoc とテストに明記した。
- `src/message/parameterArb.ts` の奇数 Property arbitrary と `src/session.prop.ts` の `publishOptionsArb` で、CODEC_STRING は妥当な UTF-8 を生成するようにした (不正な UTF-8 はラウンドトリップしないため)。`publishOptionsArb` には `locTimescale` / `locVideoConfig` / `locAudioConfig` / `locCodecString` も追加し、`buildPublishTrackProperties` の roundtrip PBT で検証する。
- 0x11 を未知型として使っていた既存テスト (`src/loc.prop.ts` / `src/loc.test.ts` / `src/dataStream.subgroup.test.ts`) の入力を 0x13 に変更した。
- LOC の仕様参照を loc-04 から loc-05 に更新した (`src/loc.ts` / README / docs / 各テスト / devtools の 33 箇所)。loc-05 の目次に対して `§` 参照がすべて存在することを確認した。devtools の `ConnectionSettings` は LOC ヘルプのリンクと表示を loc-05 にし、Properties 一覧に Codec String を追加した。
- README の LOC 対応版を `draft-05` にし、Codec String を実装済みの一覧へ加えた。
- テストは ASCII / マルチバイト UTF-8 / 先頭 BOM 付き文字列 / 空文字列の送信拒否 / 受信側の長さ 0 の受理 / 孤立サロゲートの送信拒否と正常なサロゲートペアの受理 / Track / Object の mutable list / Immutable 内側の解決 (video / audio)、不正 UTF-8 (overlong / サロゲート / 切り詰めを含む) の拒否 (Track / Object) と寛容デコードでの読み飛ばし、重複の malformed、Length 切り詰めを検証する。完了時点で 273 ファイル / 4919 テストが通り、`vp check` / `vp exec tsc --noEmit` / `vp test run` / `vp run build` / `vp run build:devtools` が通る。

### 既知の制限

- MSF catalog の codec と LOC の CODEC_STRING が矛盾した場合の新しい優先規則は追加していない (issue の設計方針どおり、LOC Property の公開・解決までを対象とする)。
- Object ごとに無条件で decoder を再構成する処理も追加していない。
- 実リレー E2E は draft-23 対応リレーが未準備のため未実施である。
