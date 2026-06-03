# Object Forwarding Preference の enum を追加する

- Priority: Low
- Created: 2026-06-03
- Completed: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/add-object-forwarding-preference-enum
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 §11.2.1 で定義されている Object Forwarding Preference (Subgroup / Datagram) を enum 定数として追加する。

## 優先度根拠

コードのコメント中では Subgroup / Datagram に言及しているが、定数として定義されていない。内部実装の型安全性のため Low。

## 一次資料の引用

draft-ietf-moq-transport-18 §11.2.1:

> Object Forwarding Preference: An enumeration indicating how a publisher sends an object. The preferences are Subgroup and Datagram.

## 現状

`src/message/types.ts` に `ObjectForwardingPreference` に相当する定義がない。コード中ではコメントや条件分岐で暗黙的に Subgroup / Datagram を区別している。

## 設計方針

`src/message/types.ts` に以下を追加:

```typescript
export const ObjectForwardingPreference = {
  SUBGROUP: 0x1,
  DATAGRAM: 0x2,
} as const;

export type ObjectForwardingPreference =
  (typeof ObjectForwardingPreference)[keyof typeof ObjectForwardingPreference];
```

## 完了条件

- `ObjectForwardingPreference` enum が定義されている
- `vp run build` 成功
