# encodeVarint / varintSize が 2^64-1 を超える入力を受け入れる

- Created: 2026-08-03
- Completed: 2026-08-13
- Branch: feature/fix-varint-overflow-wrap
- Polished: 2026-08-07

## 目的

draft-ietf-moq-transport-19 §1.4.1 は可変長整数で「Integers are encoded in 1 to 9 bytes and can encode up to 64 bit unsigned integers.」と定め（表 1 の 9 バイト行の Range は 0-2^64-1）、これを超える値は仕様の範囲外である（範囲外の扱いは仕様側の規定ではなく encode 対象外の読みに基づく）。2^64-1 を超える入力が無音で mod 2^64 にラップされ、ワイヤ上で別の有効値として送信されるデータ破壊経路を修正する。

## 現状

- `src/varint.ts` の `encodeVarint()` は負値のみを拒否し、上限チェックがない。`varintSize()` が 8 バイト閾値超を無条件に 9 を返すため、2^64 以上の入力は 9 バイト分岐のマスク処理（`& 0xffn`。マスク自体は正しい処理）で上位ビットが切り捨てられる。`varintSize()` 単体でも範囲外値を検出しない。
- 例: `encodeVarint(2^64n)` は `[0xff, 0, 0, 0, 0, 0, 0, 0, 0]` を返し、デコードすると 0 になる。`encodeVarint(2^64n + 5n)` は 5 になる（bigint の場合。number リテラルでは 2^53 超の丸めにより成立しない）。
- `src/varint.test.ts` / `src/varint.prop.ts` は 2^64-1 までの値しか扱わず、範囲外入力のテストがない。

## 設計方針

- `varintSize()` に入力値の上限検証（2^64-1 以下）を追加し、超過時は既存の負値チェックと同じ `Error`（英語メッセージ）を投げる。`encodeVarint()` は内部で `varintSize()` を呼ぶため、検証は 1 箇所で両方がカバーされる（encodeVarint 側の既存の負値チェックはそのまま維持する）。定数名は `MAX_VARINT`（2^64-1）で `src/varint.ts` に定義・export する（既存定数の `MAX_VARINT` への置き換えは別 issue 0394 で対応する）。`encodeVarint()` は number も受け付けるが、2^53 超の number は整数の一部しか正確に表現できない（丸めは呼び出し側の責務）。一方 2^64 は IEEE double で正確に表現可能なため、`encodeVarint(2 ** 64)`（number）も検証で throw する。`varintSize()` / `encodeVarint()` の doc comment に範囲外入力で例外を投げる旨を追記する。
- `encodeVarint()` に範囲外値を渡し得る呼び出し側（`encodeLocation()`（group / object 値）/ `encodeRangeFilter()`（delta 値）/ `encodeTimestamp()` / `encodeTimescale()` / `expires` 等のパラメータ値 / object properties の gap 値（PRIOR_GROUP_ID_GAP / PRIOR_OBJECT_ID_GAP）/ properties.ts の Property エンコード経路 / publish の groupId・datagram 経路等）を洗い出し、影響を確認する。上限チェックによりデータ破壊は例外で防がれるため、呼び出し側の検証追加は必須ではない。ただし洗い出しの結果、検証追加が必要と判断された経路が現れた場合は、その対応は別 issue に切り出して記録する。既存検証済み経路（objectId 等）はそのまま維持し、`encodeVarint()` の例外は各経路に伝播する（publishSendObject 経路では publisher.handleError に、publishSendDatagram 経路では同期 throw として）。プロトコル違反の処理（`SessionError` / closeWithError）には影響しない。洗い出し結果と影響なしの判断根拠は、closed 時の「解決方法」セクションに記録する。publishSendObjectInternal の新規 Subgroup 経路では `encodeSubgroupHeader()` の throw 時点でストリームと writer ロックが残るため、方式は実装時に次の 2 案から 1 つを確定する: (a) 現状の呼び出し位置のまま後始末（releaseLock / closedSubgroups 登録）を追加する。ただし本 throw はローカルバリデーション（2^64 超の trackAlias / groupId）起因でありストリームは健全に開かれた直後のため、既存の write 失敗経路（リモート起因・ストリーム破損前提）と違い、releaseLock だけではピアに FIN / RST が送られない。後始末に `writer.close()`（または abort）を含めるか、ピアに破棄を通知する扱いを確定する。(b) ヘッダエンコードをストリーム生成前に移動して throw 時点で副作用をなくす（ストリーム生成前移動案。エンコードがストリーム生成より先になるため、`statsUnidirectionalStreamsOpened` 等の統計カウントは自動的にエンコード成功後に来る。統計カウントの位置は変更しない）。完了条件 5 は確定した方式に応じて括弧内の該当案を適用する。

## 完了条件

- `src/varint.ts` に `MAX_VARINT`（2^64-1）が定義され export されていること。
- `encodeVarint(2^64n)` 等の 2^64-1 超過入力（bigint）が例外を投げる。2^64-1 ちょうどの入力は例外にならず従来どおり 9 バイトでエンコードされること。
- `varintSize(2^64n)` が例外を投げる。2^64-1 ちょうどは例外にならないこと。
- `src/varint.test.ts` に 2^64-1 超過の固定値（`2^64n` / `2^64n + 5n`）の `assert.throws` テスト、number 入力の `assert.throws(() => encodeVarint(2 ** 64))` テスト、`varintSize(2^64-1n)` が 9 を返す境界テスト、`assert.throws(() => varintSize(2 ** 64))` テスト、`src/varint.prop.ts` に 2^64 以上（例: 2^64 〜 2^80 程度の範囲）の範囲外 Arbitrary のテスト（`encodeVarint` / `varintSize` 両関数を対象）が追加されていること。
- publishSendObjectInternal の新規 Subgroup 経路で `encodeSubgroupHeader()` が throw した場合の後始末が、設計方針で確定した方式どおりに実装されていること。方式 (a) の場合は closedSubgroups への登録と publisher.handleError への伝播（および方式 (a) で確定したピアへの破棄通知の扱い）を検証するテスト、方式 (b) の場合はストリーム未生成と統計カウント不変を検証するテストがあること。
- `varintSize()` / `encodeVarint()` の doc comment に範囲外入力で例外を投げる旨が追記されていること。
- 設計方針に挙げた呼び出し側経路（encodeLocation / encodeRangeFilter / encodeTimestamp / encodeTimescale / expires 等のパラメータ / gap 値 / properties.ts の Property エンコード / publish の groupId・datagram）の洗い出し結果と影響なしの判断根拠（影響ありと判断された経路の別 issue 切り出し含む）が、closed 時の「解決方法」セクションに記録されていること。
- 0379 の issue ファイルに、本 issue（0363）との相互参照と「上限定数は 0363 で導入される `src/varint.ts` の `MAX_VARINT` を参照する」旨の注記が追加されていること（0379 が独自定数を定義しないための調整）。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §1.4.1 (Variable-Length Integers)（「Integers are encoded in 1 to 9 bytes and can encode up to 64 bit unsigned integers.」/ 表 1 の 9 バイト行: Range 0-18446744073709551615（= 2^64-1））
- 関連: `0394-refactor-unify-max-varint-constant.md`（既存定数の `MAX_VARINT` への置き換え。実装順は先に本 issue）
- 関連: `0379-moqt-draft-19-delta-type-overflow-validation.md`（受信側の Delta Type 加算の 2^64-1 超過検証。`MAX_VARINT` 定数を再利用できるよう本 issue を先に実装する）

## 解決方法

- `src/varint.ts` に `MAX_VARINT` (2^64-1) を定義して export した
- `varintSize()` に入力値の上限検証 (2^64-1 以下) を追加し、超過時は既存の負値チェックと同じ `Error` を投げるようにした。`encodeVarint()` は内部で `varintSize()` を呼ぶため、両関数が 1 箇所の検証でカバーされる
- `varintSize()` / `encodeVarint()` の doc comment に範囲外入力で例外を投げる旨を追記した
- `src/varint.test.ts` に固定値テスト (2^64-1 ちょうどは 9 バイトでエンコード、2^64 以上 (bigint / number) は例外) を追加した
- `src/varint.prop.ts` に 2^64 〜 2^80 の範囲外 Arbitrary のテストを追加した (encodeVarint / varintSize 両関数)
- `publishSendObjectInternal` の新規 Subgroup 経路は方式 (b) (ストリーム生成前移動) を採用した。Subgroup Header のエンコードを `createUnidirectionalStream()` より前に移動し、trackAlias / groupId が 2^64 超の場合にストリーム未生成・統計カウント不変のまま throw する。`src/session/publish.test.ts` にストリーム未生成と統計カウント不変を検証するテストを追加した
- **呼び出し側経路の洗い出し結果**: `encodeVarint` の呼び出し側はすべてアプリが値を渡す経路 (expires / deliveryTimeout / fillTimeout / Location / Range Filter / LOC timestamp / Property エンコード / publish の groupId・objectId / datagram) であり、2^64 超の入力が流れた場合は例外が throw され、ストリーム経路は publisher.handleError に、datagram 経路は同期 throw としてアプリに伝播する。データ破壊 (無音の mod 2^64 ラップ) は例外で防がれるため、呼び出し側の検証追加は必須ではないと判断した
  - 補足: `publishSendObjectInternal` の objectId=2^64-1 指定時は delta 計算 (previousObjectId=-1n との差) が 2^64 になり `encodeObjectFields` が throw して handleError に伝播する。この経路はストリーム生成後のため方式 (b) の保護対象外だが、従来の「無音ラップ (ピアが 0 を誤受信)」から「throw」に改善されておりデータ破壊はない
- `CHANGES.md` の `## develop` に `[FIX]` エントリを追加した
