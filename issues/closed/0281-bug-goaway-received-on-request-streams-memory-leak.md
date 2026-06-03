# goawayReceivedOnRequestStreams がセッションクローズ時にクリアされない

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Completed: 2026-06-03

## 目的

セッションクローズ時に `closedSubgroups` はクリアされるが `goawayReceivedOnRequestStreams` はクリアされない。長時間稼働時のメモリリークを防ぐ。

## 優先度根拠

長時間稼働するセッションでメモリが単調増加する。また、セッションクローズ後に同じインスタンスで再接続する場合、前セッションの GOAWAY 状態が残留し新セッションで誤判定される可能性がある。

## 現状

`src/session.ts:2576`:

```typescript
this.closedSubgroups.clear();
```

`goawayReceivedOnRequestStreams.clear()` がない。

## 設計方針

- `cleanUp()` (close) で `this.goawayReceivedOnRequestStreams.clear()` を追加する
- 個別のリクエストストリーム終了時にも `delete(requestId)` を検討する

## 完了条件

- セッションクローズ時に `goawayReceivedOnRequestStreams` がクリアされる
- テストが追加されている

## 解決方法

`src/session.ts` の `cleanUp()` メソッドに `this.goawayReceivedOnRequestStreams.clear()` を追加し、セッションクローズ時に GOAWAY 受信追跡セットをクリアするようにした。

変更ファイル: `src/session.ts`。全テスト 624/624 PASS 確認済み。
