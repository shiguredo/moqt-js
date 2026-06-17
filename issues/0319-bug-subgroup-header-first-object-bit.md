# Subgroup Header の FIRST_OBJECT ビットを設定する

- Priority: High
- Created: 2026-06-17
- Model: Opus 4.8
- Branch: feature/fix-subgroup-header-first-object-bit

## 目的

Original Publisher が新しい subgroup を開く最初の object を送信する際、Subgroup Header の `FIRST_OBJECT` ビット (`0x40`) を設定するように修正する。現在の `sendObjectInternal` は常に `SubgroupHeaderType.FIRST_OBJ_EXT` (`0x13`) を使用しているが、これは FIRST_OBJECT ビットを含むヘッダー型ではなく、実際のビットが立っていない。

## 優先度根拠

draft-ietf-moq-transport-18 §11.4.2 / §2.2 では、新しい subgroup の最初の object に対して `FIRST_OBJECT` ビットを設定することが MUST とされている。設定しないと、受信側は subgroup 内の最初の object を正しく識別できず、依存関係の解決やデコーダーの初期化が失敗する。相互運用に直結するため High。

## 現状

`src/session.ts` の `sendObjectInternal` L2959 付近において、Subgroup Header の種別として `SubgroupHeaderType.FIRST_OBJ_EXT` (`0x13`) を常に使用している。

```typescript
// src/session.ts:2959 付近 (概略)
const headerType = SubgroupHeaderType.FIRST_OBJ_EXT;
```

`FIRST_OBJ_EXT` は拡張ヘッダー型を表す型値だが、これ単独では `FIRST_OBJECT` ビット (`0x40`) が立っていない。新しい subgroup の最初の object かどうかに応じて、`FIRST_OBJECT` ビットを OR した値を使用する必要がある。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§11.4.2 (Subgroup Header)**: Original Publisher は新しい subgroup を開く際、最初の object の header type に `FIRST_OBJECT` ビット (`0x40`) を設定しなければならない (MUST)。
- **§2.2 (Object)**: `FIRST_OBJECT` ビットが立つ object は、その subgroup 内で他の object の decode に必要な初期情報を含む。

## 設計方針

`sendObjectInternal` において、送信対象の object が所属する subgroup の最初の object かどうかを判定し、ヘッダー型に `FIRST_OBJECT` ビットを付与する。

- 判定方法:
  - 既存の送信状態 (`closedSubgroups` または `publisherStreams` 等) を参照し、当該 subgroup に対してまだ object が送信されていない場合に `FIRST_OBJECT` ビットを立てる。
  - または、呼び出し側 (`Publisher` API 等) から明示的に `isFirstObject` フラグを渡す。
- ヘッダー型の計算:
  - 基本型 (`FIRST_OBJ_EXT` 等) に対し、`0x40` を OR する。
  - 最初の object でない場合は `FIRST_OBJECT` ビットを立てない。
- 状態管理:
  - 各 subgroup ごとに「最初の object を送信済みか」を追跡する。
  - subgroup が閉じられた後、再び同じ subgroup ID が使われるケースについては draft の規定に従う。

## 完了条件

- 新しい subgroup の最初の object に `FIRST_OBJECT` ビット (`0x40`) が設定される
- 2 番目以降の object には `FIRST_OBJECT` ビットが立たない
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する
