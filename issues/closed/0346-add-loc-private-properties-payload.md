# LOC Object Payload に Private Properties フレーミングを実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: 2026-07-24
- Model: Composer
- Branch: feature/add-loc-private-properties-payload
- Polished: 2026-07-24

## 目的

draft-ietf-moq-loc-04 §2.2 は、MOQ Object Payload を「LOC Private Properties + LOC Payload」と定義する。現状の高レベル API / `src/loc.ts` は Object Payload に Encoded\*Chunk の internal data（LOC Payload）だけを載せ、非空の Private Properties を Payload 側へ載せる encode / decode 経路が無い。

本 issue は **平文 Object Payload 上の Private Properties 連結 / 分割ヘルパ** を `src/loc.ts` に追加し、空 Private 時は現行ワイヤ（生チャンク）とビット一致する方針をテストで固定する。機密メタデータを Private へ移す判断と Secure Objects 暗号化は `#0353` の担当とする。本番 Object への非空 Private 配線は本 issue では行わない。

## 優先度根拠

`#0344`（Property ID 追従）は完了済み。§2.2 が求める非空 Private を平文 Object Payload に載せる手段がまだ無い。空 Private のままなら現行どおり再生できるため、暗号化未実装でもブロッカーではない。よって Medium。

## 現状

正本は `refs/moq/draft-ietf-moq-loc-04.txt`。

### 仕様が言うこと / 言わないこと

- §2.2 (refs L286-315): `LOC Public Properties = some MOQ Object Properties`、`LOC Private Properties + LOC Payload = all MOQ Object Payload`、図は **Private → LOC Payload** の順。LOC Payload は EncodedAudio/VideoChunk の "internal data"
- §2.3 (refs L319-355): 個別 Property の Length は奇数 ID の Value 長。**Private ブロック全体の長さ prefix は loc-04 に定義が無い**
- §3.1.3 (refs L518-545): 機密メタデータは Secure Objects の Private properties mechanism (**type 0xA**) に MAY で委ねる。暗号化前に Private と media を「concatenated」とだけ書き、平文区切りバイト列は定義しない。機密時の SHOULD は §5.1
- transport-19 §11.2.1.2: Relay が触るべきでないメタデータは Object Property ではなく Object Payload に SHOULD で載せる（配置の補強）
- transport-19 §1.4.3 / §2.5: Key-Value-Pair 列は既知バイト長でパースする。Object Properties は明示長が先行する（本 issue の暫定 length の類推根拠。Private ブロック長の規範ではない）
- `refs/moq/` に `draft-ietf-moq-secure-objects` は未取得（`#0353` pending 理由と同一）。loc-04 §3.1.3 は type 0xA への委任と concatenated までしか言わない。平文暫定ワイヤと暗号化 plaintext は **別レイヤ**であり、本ヘルパ出力を暗号化入力にそのまま流用しない。詳細レイアウトは Secure Objects 取得後に `#0353` で固定する

### 実装

- `src/loc.ts`: Public 向け `encode*Properties` / `decode*Properties`（絶対 Type 連結）はある。Object Payload の連結 / 分割 API は無い。冒頭コメントは「LOC Payload には internal data をそのまま使用」
- `createMediaPublisher`: `payload: chunk.data` + Object Properties に Public LOC Properties（L579 / L622）
- `createMediaSubscriber`: `obj.payload` をそのまま WebCodecs へ（L751 / L777）
- `devtools` の `usePublisher` / `useSubscriber`: 同様に payload = internal data そのまま
- 欠けるのは **非空 Private を載せる手段** と、そのときの区切り規則の明示（空 Private なら現行ワイヤで足りる）

## 設計方針

### 規範とリポジトリ決定の分離

1. **配置（規範）**: Object Properties ← LOC Public Properties、Object Payload ← LOC Private Properties + LOC Payload（loc-04 §2.2）。transport-19 §11.2.1.2 の SHOULD とも整合する
2. **平文の区切り（リポジトリ暫定）**: loc-04 にブロック長が無いため、次を暫定ワイヤとして固定する。コメントには「loc-04 §2.2 は配置のみ・区切りは暫定・Secure Objects 取得後に見直しうる」と書き、**issue 番号はコードに書かない**

### 暫定ワイヤ（平文）

| Private               | Object Payload のバイト列                                                            |
| --------------------- | ------------------------------------------------------------------------------------ |
| 空 / 未使用（長さ 0） | LOC Payload のみ（**現行と同じ生チャンク。prefix 無し**）                            |
| 非空                  | `Private Properties Length (varint)` + `Private Properties バイト列` + `LOC Payload` |

- 非空時の length prefix は LOC Private Properties **領域のシリアライズ（区切り）**であり、§2.2 の配置（Private 領域の後に LOC Payload）は維持する。等式の左辺は「length 付き Private 領域 + LOC Payload」と読む
- Private Properties バイト列の中身は呼び出し側規約。本 API はフレーミングのみ。推奨は現行 Public と同じ **絶対 Type 連結**（`encodeVideoProperties` / `encodeAudioProperties` の出力を渡す）。`properties.ts` の delta `encodeProperties` は使わない（Public の delta 未対応と同じく範囲外）。Secure Objects の 0xA 内 KVP は `#0353` で別契約になりうる
- type `0xA` コンテナ・AEAD・Key ID・本番配線は本 issue 範囲外
- 非空を送る送信者と受信者は、同じヘルパで encode / decode する契約とする。先頭バイトからの自動判定はしない
- **空のカノニカル形は prefix 無しのみ**。`varint(0) + LOC Payload` は正規 encode が出さない。`framed: true` で length=0 を見たら `ProtocolViolationError`

### API（`src/loc.ts`、`LOC` 名前空間で公開）

```ts
/**
 * 空 privateProperties（length 0）は locPayload とビット一致するバイト列を返す。
 * 入力との参照同一性は保証しない（コピーしてよい）。
 */
encodeLocObjectPayload(
  privateProperties: Uint8Array,
  locPayload: Uint8Array,
): Uint8Array;

/**
 * framed=false（既定）: 全体を LOC Payload とみなし privateProperties は空
 * framed=true: 先頭 varint を Private 長として分割
 *   - エラーになるのは privateLength > varint 消費後の残バイト数のときのみ
 *     （残バイトはすべて locPayload。空でも非空でもよい。残があってもエラーにしない）
 *   - length=0 / 空バッファ / 不完全 varint / privateLength 超過 / Number.MAX_SAFE_INTEGER 超は
 *     すべて ProtocolViolationError
 *     （内部で IncompleteDataError が出ても外向けには ProtocolViolationError に変換する。
 *      完全に揃った Object Payload 上での次チャンク待ちは起きない）
 *   - privateLength は bigint のまま残り長と比較する
 * 戻り値の privateProperties / locPayload は入力の独立コピー（view 共有しない）
 */
decodeLocObjectPayload(
  objectPayload: Uint8Array,
  options?: { framed?: boolean },
): { privateProperties: Uint8Array; locPayload: Uint8Array };
```

名前は実装時に微調整してよいが、入出力契約は変えない。

### 高レベル / devtools の範囲

- **本 issue では配線しない**。`createMediaPublisher` / `createMediaSubscriber` / `usePublisher` / `useSubscriber` は空 Private（生チャンク）のまま
- 本番 Object への非空 Private 配線と受信 unwrap は本 issue 範囲外（`#0353` の暗号化作業と混同しない。必要なら別 issue または `#0353` 磨き時に範囲を足す）
- `loc.ts` 冒頭コメントを「空 Private 時は Payload = internal data。非空時は暫定フレーミング API を使う」に更新する
- `devtools/main.ts` の死んだ `LOC.packVideo` / `LOC.unpackVideo` は範囲外

### テスト（`src/loc.prop.ts`、モック禁止）

- 空 Private: encode 結果が LOC Payload とビット一致する（`===` 参照同一性は要求しない）
- 非空: encode → `framed: true` decode の round-trip（非空 private + 非空 locPayload で残りが locPayload になること）
- `framed: false`: 全体が locPayload、private は空
- `framed: true` の不正はすべて `ProtocolViolationError`（`IncompleteDataError` ではない）:
  - 空バッファ、不完全 varint、length=0、privateLength が残り超過、`Number.MAX_SAFE_INTEGER` 超
- 負例: 空 encode 結果を `framed: true` で decode すると、生チャンク先頭を誤分割しうるため **round-trip ではない**（空は `framed: false` または decode しない）
- 任意: `encodeVideoProperties` → encode → framed decode → `decodeVideoProperties` の結合 1 本

### 後方互換・CHANGES

- 高レベル未配線のため現行送受信ワイヤは変わらない
- 公開 `LOC` に API 追加 → `CHANGES.md` の `## develop` に `[ADD]` を追記する
- CHANGES / コードコメントに **issue 番号を書かない**。理由は「平文区切りは暫定で、Secure Objects 取得後に変わりうる」と節・事実で書く

## 完了条件

### コードベース

- `encodeLocObjectPayload` / `decodeLocObjectPayload`（または契約同等の公開 API）が `src/loc.ts` にあり、`LOC` 経由で公開される
- 空 Private は prefix 無しで LOC Payload とビット一致する
- 非空は `varint(len) + private + locPayload` で、`framed: true` decode と round-trip できる
- `framed: true` の失敗（空・不完全 varint・length=0・privateLength 超過・`Number.MAX_SAFE_INTEGER` 超）は外向け `ProtocolViolationError` のみ（`IncompleteDataError` を漏らさない）
- type 0xA / 暗号化 / 高レベル配線は入っていない
- `loc.ts` 冒頭コメントが空 / 非空の契約と暫定である旨を述べている（issue 番号なし）
- 高レベル API / devtools の送受信経路は未変更

### テスト / コマンド

- `src/loc.prop.ts` に上記ケースがある
- `vp run test` / `vp run build` が pass する

### 変更履歴

- `CHANGES.md` の `## develop` に `[ADD]`（公開 LOC API 追加。平文区切りは暫定である旨。issue 番号なし）がある

## 解決方法

1. `src/loc.ts` に `encodeLocObjectPayload` / `decodeLocObjectPayload` を追加し、`LOC` 名前空間経由で公開した
2. 空 Private は length prefix 無しで LOC Payload とビット一致、非空は暫定ワイヤ `varint(len) + Private + LOC Payload` とした
3. `framed: true` の不正（空バッファ・不完全 varint・length=0・超過・`Number.MAX_SAFE_INTEGER` 超）は外向け `ProtocolViolationError` のみとした（`IncompleteDataError` は変換）
4. モジュール冒頭コメントを空 / 非空の契約と暫定ワイヤである旨に更新した（issue 番号は書かない）
5. `src/loc.prop.ts` に空一致・非空 round-trip・multi-byte varint・空 locPayload・framed=false・不正長・負例・VideoProperties 結合のテストを追加した
6. 高レベル API / devtools の送受信経路は未変更のままとした
7. `CHANGES.md` の `## develop` に `[ADD]` を追記した（平文区切りは暫定である旨。issue 番号なし）

## 関連

- `#0344` LOC draft-04 Property ID 追従（完了済み。§2.2 フレーミングを本 issue へ委譲）
- `#0353` LOC Secure Objects 統合（暗号化・type 0xA・機密メタの Private 移行。平文ヘルパとは別レイヤ）
- `#0347` LOC Track Property スコープ（兄弟・非重複）
