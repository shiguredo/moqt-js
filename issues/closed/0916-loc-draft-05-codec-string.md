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
- draft-ietf-moq-transport-23 §10.7 に従い、mutable list だけでなく Immutable Properties の内側も検索する。`decodeProperties` の出力では Immutable の `property.data` は本文だけなので、内側を `decodeProperties` で読み直す (`supportsDynamicGroups` と同じ扱い)。mutable list を優先する。
- `src/properties.ts` で CODEC_STRING を対応済み Property として登録した。`SUPPORTED_PROPERTY_TYPES` / `KNOWN_PROPERTY_TYPES` に加え、scope は 0913 の `PROPERTY_SCOPES` (Track / Object 両方) を共有する。重複検証も 0914 の汎用規則に乗る。
- 受信検証として、CODEC_STRING の Value が UTF-8 として不正な場合は §8.3 の serialization 不一致として MALFORMED_KEY_VALUE で拒否する (`assertLocCodecStringValue`)。`decodeProperties` (Track) と `assertKnownPropertyValueInObjectProperties` (Object) の両方で検証する。Length の切り詰めも既知 Type の長さ不一致として MALFORMED_KEY_VALUE になる。
- `src/message/parameterArb.ts` の奇数 Property arbitrary で、CODEC_STRING は妥当な UTF-8 を生成するようにした (不正な UTF-8 はラウンドトリップしないため)。
- 0x11 を未知型として使っていた既存テスト (`src/loc.prop.ts` / `src/loc.test.ts` / `src/dataStream.subgroup.test.ts`) の入力を 0x13 に変更した。
- LOC の仕様参照を loc-04 から loc-05 に更新した (`src/loc.ts` / README / docs / 各テスト)。loc-05 の目次に対して `§` 参照がすべて存在することを確認した。
- README の LOC 対応版を `draft-05` にし、Codec String を実装済みの一覧へ加えた。
- テストは ASCII / マルチバイト UTF-8 / 空文字列の往復、Track / Object の解決、Immutable 内側の解決と mutable 優先、不正 UTF-8 の拒否 (Track / Object)、重複の malformed、Length 切り詰めを検証する。`vp check` / `vp run typecheck` / `vp test run` (272 ファイル / 4843 テスト) が通る。

### 既知の制限

- MSF catalog の codec と LOC の CODEC_STRING が矛盾した場合の新しい優先規則は追加していない (issue の設計方針どおり、LOC Property の公開・解決までを対象とする)。
- Object ごとに無条件で decoder を再構成する処理も追加していない。
- 実リレー E2E は draft-23 対応リレーが未準備のため未実施である。
