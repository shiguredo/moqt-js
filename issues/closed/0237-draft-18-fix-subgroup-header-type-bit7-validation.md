# Subgroup Header Type のバリデーションに bit 7 (0x80) のチェックを追加する

- Priority: Medium
- Created: 2026-06-03
- Completed: 2026-06-03

注: 本 issue の修正内容は 0234 (FIRST_OBJECT bit 追加) の一部として同時実装済み。

- Model: deepseek-v4-pro
- Branch: feature/fix-subgroup-header-type-bit7-validation
- Polished: 2026-06-03
- Branch: feature/fix-subgroup-header-type-bit7-validation

注: 本 issue の修正内容は 0234 (FIRST_OBJECT bit 追加) の一部として同時実装可能。0234 の実装時に本 issue も完了とみなせる。

## 目的

draft-ietf-moq-transport-18 §11.4.2 で規定されている Subgroup Header Type の形式 `0b0XX1XXXX` のうち、bit 7 MUST be 0 の検証が抜けているバグを修正する。

## 優先度根拠

0x90 などの bit 7 がセットされた不正な Type 値がバリデーションを通過し、後続の switch 文で誤ったデコードやエラーにつながる。実際のプロトコル違反を検出できないのはセキュリティ/堅牢性の観点から問題だが、攻撃者が意図的に送らない限り発生しないため Medium。

## 一次資料の引用

draft-ietf-moq-transport-18 §11.4.2 (Subgroup Header):

> The Type field in the SUBGROUP_HEADER takes the following form:
>
> ```
>  0 1 2 3 4 5 6 7
> +-+-+-+-+-+-+-+-+
> |0|X|X|1|X|X|X|X|
> +-+-+-+-+-+-+-+-+
> ```
>
> Bit 7 MUST be set to 0.

draft-ietf-moq-transport-18 §11.4.2:

> Values of Subgroup Header Type that are not defined above are invalid. If an endpoint receives an invalid type, it MUST close the session with a PROTOCOL_VIOLATION error.

## 現状

`src/dataStream.ts:244`:

```typescript
if ((typeNum & 0x10) === 0) {
  throw new ProtocolViolationError(`invalid subgroup header type: 0x${typeNum.toString(16)}`);
}
```

bit 4 (= 0x10) のチェックのみで、bit 7 (= 0x80) のチェックがない。0x90 (bit 7 セット, bit 4 セット) が誤って通過する。

## 設計方針

### バリデーションの修正

```typescript
// draft-ietf-moq-transport-18 §11.4.2:
// "Bit 4 MUST be set to 1. Bit 7 MUST be set to 0."
if ((typeNum & 0x10) === 0 || (typeNum & 0x80) !== 0) {
  throw new ProtocolViolationError(`invalid subgroup header type: 0x${typeNum.toString(16)}`);
}
```

## 影響範囲

- `src/dataStream.ts:244`: バリデーション条件を修正
- `src/dataStream.test.ts`: 0x90, 0x91 等の bit 7 がセットされた不正値のテストを追加

## 完了条件

- 0x90, 0x91 等の bit 7 がセットされた Subgroup Header Type が ProtocolViolationError になる
- 有効な Type 値 (0x10-0x1D, 0x30-0x3D, 0x50-0x5D, 0x70-0x7D) は引き続き通過する
- 不正値のテストが追加されている
- `vp run test` 全パス
- `vp run build` 成功

## 解決方法

0234 の実装の一部として修正。`src/dataStream.ts` の `decodeSubgroupHeader` で `(typeNum & 0x80) !== 0` のチェックを追加した。
