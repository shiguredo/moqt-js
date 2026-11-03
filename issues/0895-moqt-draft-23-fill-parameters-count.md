# FILL_PARAMETERS の外側 Length を除き Parameter count で区切る

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-fill-parameters-count
- Polished: 2026-11-03

## 目的

draft 23 §9.19.15 は FILL_PARAMETERS を Number of Parameters とその個数の Parameters で符号化する。draft 22 の外側 Length が残ると、fill を含む SUBSCRIBE / REQUEST_UPDATE などの後続フィールドを誤読する。

## 現状

- `src/message/parameter/messageParameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` は 0x23 を `length-prefixed` とする
- `encodeFillParameters` 自体は既に `encodeParameters` で count を含む Value を作るが、外側の `encodeMessageParameter` がさらに Length を付ける
- `decodeFillParameters` は渡された Value 内を検証できる一方、外側の `decodeMessageParameter` は Length を必要としている

## 設計方針

- FILL_PARAMETERS 専用の自己区切り処理を持たせ、count と内側 Parameters の消費バイト数で Value の終端を決める。外側 Length は書かない
- 内外の Parameter scope、Type Delta の基準、重複検証は独立させる。LOCATION_FILTER や Range Filter を含む内側の既存検証を維持する
- 許可されない内側型とネストを拒否し、切り詰めを後続パラメータの一部として誤認しない
- PUBLISH / SUBSCRIBE_TRACKS での fill の利用は 0907 / 0908 が扱う。本 issue は共通ワイヤ形式に絞る

## 完了条件

- 空の fill が count 0 のみで表現され、旧 Length を含まない固定ワイヤで検証される
- 内側の複数型、外側の後続パラメータ、Track Properties、チャンク境界で正しい消費長になる
- 内側 Type Delta、重複、未知型、切り詰めと異常な count を検証する
- `src/message/parameter.test.ts` / `parameter.prop.ts` などの旧ワイヤ期待値を更新する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §9.19 / §9.19.15 / §A.1
- `src/message/parameter/messageParameter.ts` の `encodeMessageParameter` / `decodeMessageParameter` / `encodeFillParameters` / `decodeFillParameters`

## 解決方法

{未着手}
