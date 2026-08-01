# Object Properties のエンコードを delta encoding に追従させる

- Created: 2026-08-01
- Completed: YYYY-MM-DD
- Branch: feature/change-object-properties-delta-encoding
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-19 §11.2.1.2 / §2.5 に基づき、Object Properties のエンコード / デコードを仕様の Key-Value-Pairs（Figure 2、delta encoding）に追従させる。現在は absolute な Type + Length + Value 形式でエンコードしており、仕様と乖離している。

## 現状

- `src/properties.ts` の `mergeDeliveryTimeoutObjectProperties()` / `readDeliveryTimeoutObjectProperties()` は、Object Properties を absolute な Type + Length + Value 形式でエンコード / デコードする。
- 一方 `src/properties.ts` の `encodeProperties()` / `decodeProperties()`（Track Properties 用）は仕様の Key-Value-Pairs（Figure 2）に従い delta encoding を使用する。
- draft-ietf-moq-transport-19 §2.5 は「Properties are serialized as Key-Value-Pairs (see Figure 2)」、§11.2.1.2 は「Object Properties are serialized as a length in bytes followed by Key-Value-Pairs (see Figure 2)」と定め、Track / Object Properties とも Figure 2 の delta encoding を使う（Object Properties のみ外側に length プレフィックスが付く）。
- 単一 Property では delta == absolute のため表面化しないが、複数 Property（OBJECT_DELIVERY_TIMEOUT と SUBGROUP_DELIVERY_TIMEOUT の両方、あるいは GREASE Property との併用）を送ると、2 番目以降の Type が delta 復元できず、仕様準拠の受信側が Property を誤読する。GREASE を Object Properties に注入する機能で顕在化した。

## 設計方針

- Object Properties のエンコード / デコードを `encodeProperties()` / `decodeProperties()` と同じ delta encoding（Figure 2）に統一する。
- `mergeDeliveryTimeoutObjectProperties()` / `readDeliveryTimeoutObjectProperties()` と、Object Properties への GREASE 注入（`appendGreaseObjectProperty()`）を delta 規約に整合させる。
- 受信側（`readDeliveryTimeoutObjectProperties()`、`src/dataStream.ts` の Object Properties デコード経路）も delta encoding に追従させる。
- 後方互換性は考慮しない（プロジェクト方針。旧 absolute 形式との相互互換は保証しない）。

## 完了条件

- Object Properties が delta encoding（Figure 2）でエンコード / デコードされる。
- 複数 Property（delivery timeout 2 種や GREASE Property の併用）を含む Object Properties が仕様準拠でラウンドトリップする。
- 既存の delivery timeout / GREASE Object Property の挙動（値の抽出・注入）が維持される。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §11.2.1.2 (Object Properties)
- draft-ietf-moq-transport-19 §2.5 (Properties) / Key-Value-Pairs (Figure 2)
- 関連: `0342-draft-19-delivery-timeout-object-property.md`（Object Properties 導入）、`0359-add-grease-properties.md`（GREASE 注入で本乖離が顕在化）
