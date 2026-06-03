# classifyIncomingStreamType が FIRST_OBJECT ビット付き SUBGROUP_HEADER タイプを認識しない

- Priority: Medium
- Created: 2026-06-03
- Model: DeepSeek V4 Pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

`classifyIncomingStreamType` 関数が draft-18 で追加された FIRST_OBJECT ビット (0x40) を含む SUBGROUP_HEADER タイプ範囲 (0x50-0x5F, 0x70-0x7F) を "subgroup" として認識するように修正する。

## 優先度根拠

`classifyIncomingStreamType` は PBT (Property-Based Testing) でのみ使用されており、実際のストリーム処理 (`handleIncomingStream`) は `src/session.ts:3618-3623` で正しく全範囲を認識しているため、実行時影響はない。ただし、PBT のテストカバレッジ漏れとコメント不整合があるため修正が必要。

## 現状

`src/session/params.ts:302-317` の `classifyIncomingStreamType` 関数は以下の範囲のみを "subgroup" として認識している：

- 0x10..0x1F (Priority Present, No FIRST_OBJECT)
- 0x30..0x3F (No Priority, No FIRST_OBJECT)

以下の FIRST_OBJECT ビット (0x40) が設定された範囲は `"unknown"` を返す：

- 0x50..0x5F (Priority Present, FIRST_OBJECT)
- 0x70..0x7F (No Priority, FIRST_OBJECT)

コメント (298-300 行目) には「0x50..0x5F と 0x70..0x7F は relay 等が生成するため、受信時に未知として扱われる」とあるが、これは不正確。クライアント（Subscriber）が relay 経由で受信する場合にも FIRST_OBJECT ビットが設定された SUBGROUP_HEADER は正常に受信されるべきである。

## 設計方針

1. `classifyIncomingStreamType` (`src/session/params.ts:309-313`) の範囲チェックに `0x50..0x5F` と `0x70..0x7F` を追加する

```typescript
// 修正後
if (
  (streamTypeNum >= 0x10 && streamTypeNum <= 0x1f) ||
  (streamTypeNum >= 0x30 && streamTypeNum <= 0x3f) ||
  (streamTypeNum >= 0x50 && streamTypeNum <= 0x5f) ||
  (streamTypeNum >= 0x70 && streamTypeNum <= 0x7f)
) {
  return "subgroup";
}
```

2. `src/session/params.ts:298-301` のコメントから「未知として扱われる」の記述を削除し、全 4 範囲を正しく認識していることを記載する

3. `src/session.prop.ts:358` の `fc.oneof` に `0x50..0x5F` と `0x70..0x7F` の範囲を追加する。またフィルタ (`session.prop.ts:372`) もこれらの範囲が "subgroup" として識別されるよう更新する

## 完了条件

- `classifyIncomingStreamType` が 0x50..0x5F と 0x70..0x7F を "subgroup" として認識すること
- PBT テストが追加された範囲をカバーしていること
- コメントが正確な内容に更新されていること

## 仕様引用

draft-ietf-moq-transport-18 Section 11.4.2 (Subgroup Header):

> bit 7 (0x40): FIRST_OBJECT bit. If set to 1, the first object in this
> subgroup stream is the first object ever published in this subgroup.

Section 3.4 (Unidirectional Stream Types):

> 0b0XX1XXXX：SUBGROUP_HEADER (Section 11.4.2)

つまり SUBGROUP_HEADER の有効な範囲はビットパターン `0b0XX1XXXX` に合致する全ての値であり、0x50-0x5F と 0x70-0x7F も含まれる。
