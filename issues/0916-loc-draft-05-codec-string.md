# LOC 05 の CODEC_STRING Property を読み書きする

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/add-loc-codec-string
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

{未着手}
