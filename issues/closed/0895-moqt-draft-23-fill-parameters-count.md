# FILL_PARAMETERS の外側 Length を除き Parameter count で区切る

- Created: 2026-11-03
- Completed: 2026-11-03
- Branch: feature/change-moqt-draft-23
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

- `src/message/parameter/messageParameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` に `"fill-parameters"` を追加し、FILL_PARAMETERS (0x23) の Value を「Number of Parameters (vi64) + その個数の Parameters」の自己区切り構造に変更した。draft-22 の外側 Length は書かず、encode は Value をそのまま書き、decode は count と内側 Parameters の消費バイト数だけで終端を確定する。
- 内側の Parameters 列は外側から独立した parameter scope として扱う。Type Delta は内側の先頭を 0 基準とし、重複検証も内側の列だけで行う。Table 7 の許可型 (FILL_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER / Range Filters) 以外の型と FILL_PARAMETERS の入れ子は受信時に拒否する。
- `encodeFillParameters` に送信前の構造検証 (Table 7 の許可型・非入れ子・重複) を追加し、`decodeFillParameters` は count 方式で再デコードする。内側の LOCATION_FILTER 値検証、Range Filter の remove 拒否・組み合わせ検証は従来どおり維持する。
- Parameters 列のデコードループを `decodeParameterListInScope` に、許可型 / 入れ子判定を `isFillParameterAllowed` に共通化し、外側と内側で同じ規則を使うようにした。
- `src/message/types.ts` の `MessageParameterType.FILL_PARAMETERS` の JSDoc を draft-23 §9.19.15 の wire とメッセージ一覧に更新した。
- 空の fill が `[0x01, 0x23, 0x00]` (count 0 のみ、外側 Length なし) になる固定ワイヤ、内側複数型、内側 Type Delta 0 基準、外側後続パラメータ、Track Properties との位置関係、チャンク境界、入れ子・一覧外型・重複・delta 加算超過・切り詰め・2^64-1 count・旧 Length 形式の拒否、セッション受信経路のエラー終了をテストした。PBT では内側のラウンドトリップと cross-scope (外側と同じ型を内側にも置ける) を検証する。
- draft-23 の INVALID_PARAMETER / DELTA_ENCODING_OVERFLOW への移行は、現行の受信経路が SessionErrorCode への変換都合で PROTOCOL_VIOLATION を返すため、コメントで差を明記して別途のエラー分類移行に委ねた。

### 既知の制限

- fill は外側 Length を持たず count 自体が境界を定義するため、内側 count が破損して大きくなり、後続の外側パラメータのバイトが偶然すべて内側の許可型として解釈できる場合は、切り詰めと判別できない (仕様上 Length が無いことの帰結)。テストで再解釈の構造まで固定した。
- `encodeFillParameters` は構造のみを検証し、内側 Range Filter の remove や LOCATION_FILTER の意味検証は行わない。型付き送信経路と受信側の `decodeFillParameters` が意味検証を担う。
- PUBLISH / SUBSCRIBE_TRACKS での fill の送受信は、セッション層の許可集合と送信 API の対応が必要なため別途扱う。

### 残課題 (別 issue で扱う)

- draft-23 の具体的なセッションエラー分類 (INVALID_PARAMETER / DELTA_ENCODING_OVERFLOW) への移行
- PUBLISH / SUBSCRIBE_TRACKS の fill 対応
- fill 内側の二重デコードのコスト最適化
