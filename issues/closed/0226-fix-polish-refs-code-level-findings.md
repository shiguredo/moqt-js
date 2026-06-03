# polish-refs 検出: コード内の仕様引用・値の誤りを修正する

Created: 2026-06-01
Completed: 2026-06-01
Priority: High
Model: deepseek-v4-flash
Branch: feature/draft-18

## 概要

polish-refs スキルによる検証で、ソースコード内に以下の誤りを検出した。
すべて draft-ietf-moq-transport-18 を一次資料とした照合で確認済み。

## 指摘一覧

### 1. ZERO_OBJECT_ID ビットのデフォルト値が仕様と不一致 (致命的)

`src/dataStream.ts` において、ZERO_OBJECT_ID ビット (0x04) がセットされた場合の
Object ID のデフォルト値が仕様と一致していない。

- 仕様: `draft-ietf-moq-transport-18 §11.3.1` — When set to 1, the Object ID is **0**
- コード: `Object ID is 1` として実装・コメント記載

#### 該当箇所

- dataStream.ts:499 コメント `(Object ID = 1)` → `(Object ID = 0)`
- dataStream.ts:529 コメント `(Object ID = 1)` → `(Object ID = 0)`
- dataStream.ts:557-558 コメント `Object ID is 1` → `Object ID is 0`
- dataStream.ts:618 バリデーション `datagram.objectId !== 1n` → `!== 0n`
- dataStream.ts:695 デフォルト値 `let objectId = 1n` → `= 0n`

### 2. PUBLISH_DONE の TOO_FAR_BEHIND と EXPIRED のコードポイントが入れ替わり (致命的)

`src/error.ts:81-82` で、仕様では `TOO_FAR_BEHIND=0x5, EXPIRED=0x6` だが、
コードでは逆 (`TOO_FAR_BEHIND: 0x6, EXPIRED: 0x5`) になっている。

- 仕様: `draft-ietf-moq-transport-18 §15.10.3`

### 3. parameter.ts の仕様参照節番号が複数箇所で誤り (重要)

| 箇所                                                  | 誤              | 正             |
| ----------------------------------------------------- | --------------- | -------------- |
| parameter.ts:28, 203, 239, 289, 326 (4096 バイト制限) | Section 10.2    | Section 2.4.1  |
| parameter.ts:262, 297 (Track Namespace Field 空禁止)  | Section 2.3     | Section 2.4.1  |
| parameter.ts:544 (SUBSCRIPTION_FILTER)                | Section 10.2.11 | Section 10.2.9 |

### 4. SUBGROUP_ID_MODE=0b11 の予約タイプ一覧が不完全 (軽微)

`dataStream.ts:235` のコメントで 0x3F までの 8 タイプのみ記載。
仕様では 0x50-0x7F 帯の 8 タイプも予約済み。

- 仕様: `draft-ietf-moq-transport-18 §11.4.2`

### 5. "extension headers" の用語が仕様と不一致 (軽微)

`dataStream.ts` 全 4 箇所のコメント・エラーメッセージで "extension headers" と
書かれているが、仕様では "properties (Section 2.5)"。

- 仕様: `draft-ietf-moq-transport-18 §11.2.1.2`

### 6. GREASE 対象レジストリ一覧に MOQT Auth Token Type が欠落 (軽微)

`grease.ts:17` の対象レジストリ一覧に 7 つ目のレジストリ
"MOQT Auth Token Type" が記載されていない。

- 仕様: `draft-ietf-moq-transport-18 §14 (Grease)`

### 7. params.ts のストリーム種別判定の引用先誤り (軽微)

`session/params.ts:296` で `Section 12.4` と書かれているが、
SUBGROUP_HEADER の Type 範囲は `Section 11.4.2`。

### 8. varint 7 バイトエンコーディング (0xFC/0xFD) を不正として reject (致命的)

`src/varint.ts:179-184` で先頭バイト 0xFC/0xFD を無効なコードポイントとして
エラーにしているが、仕様では 7 バイトエンコーディング (prefix 1111110) として有効。
同様に `varintSize` / `encodeVarint` も case 7 が欠落しており、
`4398046511104`〜`562949953421311` の値を 8 バイトにエンコードしてしまう不整合があった。

#### 該当箇所

- varint.ts:179-184: 0xFC/0xFD を 7 バイトとして処理するよう修正
- varint.ts:30: `THRESHOLD_7BYTE` 追加
- varint.ts:47: `varintSize` に 7 バイト分岐追加
- varint.ts:107-118: `encodeVarint` に case 7 追加
- テスト: varint.test.ts, varint.prop.ts を 7 バイト対応

### 9. SubgroupHeader エラーメッセージのバイナリ形式が仕様と不一致 (重要)

`dataStream.ts:246` でエラーメッセージに `0b00X1XXXX` と書かれているが、
仕様では `0b0XX1XXXX` (bits 5-6 は don't-care)。

- 仕様: `draft-ietf-moq-transport-18 §11.4.2`

### 10. grease.ts のレジストリ名が仕様と不一致 (軽微)

`grease.ts:17` で `Data Stream Reset Error Codes` と書かれているが、
仕様では `Stream Reset Error Codes`。

- 仕様: `draft-ietf-moq-transport-18 §14`

### 11. 関数名 datagramHasExtensions が仕様用語と不一致 (軽微)

`dataStream.ts:571,628,712` の関数名 `datagramHasExtensions` が
仕様の "PROPERTIES bit (0x01)" と一致していない。
Subgroup 側の同等関数は `hasPropertiesPresent` と正しく命名されている。
関数名を `datagramHasProperties` に改名。

- 仕様: `draft-ietf-moq-transport-18 §11.3.1`

### 12. 日本語コメント "拡張" が仕様用語と不一致 (軽微)

`dataStream.ts:326,393,1023` の日本語コメントで "拡張" と書かれているが、
仕様では "Properties"。"拡張" → "プロパティ" に修正。

- 仕様: `draft-ietf-moq-transport-18 §11.2.1.2`

### 13. Fetch Serialization Flags コメントのビット名が仕様と不一致 (軽微)

`dataStream.ts:843-844` のコメントで `Object ID field` / `Group ID field` と
書かれているが、仕様の Table 9 では `Object ID Delta` / `Group ID Delta`。

- 仕様: `draft-ietf-moq-transport-18 §11.4.4.1 Table 9`

## 変更内容

指摘 1〜13 に対応する修正を各ファイルに適用済み。

- `src/dataStream.ts`: ZERO_OBJECT_ID デフォルト値修正、SUBGROUP_ID_MODE 予約タイプ一覧補完、extension headers→properties 用語修正、エラーメッセージ `0b00X1XXXX`→`0b0XX1XXXX`、関数名 `datagramHasExtensions`→`datagramHasProperties`、日本語コメント `拡張`→`プロパティ`、Fetch Serialization Flags コメント修正
- `src/error.ts`: PUBLISH_DONE TOO_FAR_BEHIND/EXPIRED コードポイント入れ替わり修正
- `src/message/parameter.ts`: 節番号参照誤り 7 箇所修正
- `src/grease.ts`: MOQT Auth Token Type 追加、レジストリ名修正
- `src/session/params.ts`: ストリーム種別判定の引用先修正
- `src/varint.ts`: 7 バイト varint (0xFC/0xFD) を有効として処理するよう修正
- `src/varint.test.ts`, `src/varint.prop.ts`: 7 バイトテストケース追加
