# encodeVarint / varintSize が 2^64-1 を超える入力を受け入れる

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-varint-overflow-wrap
- Polished: 2026-08-03

## 目的

draft-ietf-moq-transport-19 §1.4.1 は可変長整数で「up to 64 bit unsigned integers」のみを定義する。2^64-1 を超える入力が無音で mod 2^64 にラップされ、ワイヤ上で別の有効値として送信されるデータ破壊経路を修正する。

## 現状

- `src/varint.ts` の `encodeVarint()` は負値のみを拒否し、上限チェックがない。`varintSize()` が 8 バイト閾値超を無条件に 9 を返すため、2^64 以上の入力は 9 バイト分岐のマスク処理（`& 0xffn`。マスク自体は正しい処理）で上位ビットが切り捨てられる。
- 例: `encodeVarint(2^64n)` は `[0xff, 0, 0, 0, 0, 0, 0, 0, 0]` を返し、デコードすると 0 になる。`encodeVarint(2^64n + 5n)` は 5 になる（bigint の場合。number リテラルでは 2^53 超の丸めにより成立しない）。
- `varintSize()` も 8 バイト閾値超を無条件に 9 を返すため、範囲外値を検出しない。
- `src/varint.test.ts` / `src/varint.prop.ts` は 2^64-1 までの値しか扱わず、範囲外入力のテストがない。

## 設計方針

- `varintSize()` に入力値の上限検証（2^64-1 以下）を追加し、超過時は既存の負値チェックと同じ `Error`（英語メッセージ）を投げる。`encodeVarint()` は内部で `varintSize()` を呼ぶため、検証は 1 箇所で両方がカバーされる（encodeVarint 側の既存の負値チェックはそのまま維持する）。定数名は `MAX_VARINT`（2^64-1）で `src/varint.ts` に定義し、`src/session/publish.ts` のインライン定数（`(1n << 64n) - 1n`）と `src/session/stream.ts` / `src/dataStream.ts` のモジュールローカル定数を置き換える（0243 の未達分）。`src/varint.prop.ts` の同名ローカル定数は export した定数で置き換える。`src/loc.prop.ts` / `src/message/authorizationToken.prop.ts` の同名定数は別値（テスト生成上限）のモジュールローカル定数であり、衝突しないためそのまま残す。`encodeVarint()` は number も受け付けるが、2^53 超の number は正確に表現できないため、検証は bigint に変換した値で行う（丸めは呼び出し側の責務）。
- `encodeVarint()` に範囲外値を渡し得る呼び出し側（`encodeLocation()` / `encodeRangeFilter()` の delta / `encodeTimestamp()` / `expires` 等のパラメータ値 / publish の groupId・datagram 経路等）を洗い出し、影響を確認する。上限チェックによりデータ破壊は例外で防がれるため、呼び出し側の検証追加は必須ではない。既存検証済み経路（objectId 等）はそのまま維持し、`encodeVarint()` の例外は各経路に伝播する（publishSendObject 経路では publisher.handleError に、publishSendDatagram 経路では同期 throw として）。プロトコル違反の処理（`SessionError` / closeWithError）には影響しない。publishSendObjectInternal の新規 Subgroup 経路では `encodeSubgroupHeader()` の throw 時点でストリームと writer ロックが残るため、既存の write 失敗経路と同様の後始末（releaseLock / closedSubgroups への登録）を行う。

## 完了条件

- `encodeVarint(2^64n)` 等の 2^64-1 超過入力（bigint）が例外を投げる。
- `varintSize(2^64n)` が例外を投げる。
- `src/varint.test.ts` に 2^64-1 超過の固定値（`2^64n` / `2^64n + 5n`）の `assert.throws` テスト、`src/varint.prop.ts` に 2^64 以上の範囲外 Arbitrary のテストが追加されていること。
- `src/session/publish.ts` の objectId 上限チェックが共用定数（`MAX_VARINT`）を使用し、呼び出し側の洗い出し・影響確認が完了していること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §1.4.1 (Variable-Length Integers)

## 解決方法

未着手。
