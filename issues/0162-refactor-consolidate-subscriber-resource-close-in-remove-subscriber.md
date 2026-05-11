# Subscriber リソース close を `removeSubscriber` に集約する

Created: 2026-05-11
Model: Opus 4.7

## 概要

issue #0144 で `App.tsx:handleRemoveSubscriber` 内に `instance.decoder.value?.close()` / `instance.session.value?.close()` を直接書いたが、これは `useSubscriber.ts:cleanupSubscriber` と同じ責務であり、知識が App.tsx と useSubscriber.ts に二重化している。

責務を `signals/subscriber.ts` の `removeSubscriber` に集約し、App.tsx 側は `sub.removeSubscriber(id)` だけを呼ぶ設計に統一する。

## 根拠

- `App.tsx:handleRemoveSubscriber` で `decoder.close()` / `session.close()` を呼ぶが、`instance.decoder.value = null` / `instance.session.value = null` の代入は行わない (Map 削除前の僅かなウィンドウで「close 済み decoder」を他経路が観測しうる)
- `useSubscriber.ts:useEffect` cleanup は「`removeSubscriber` が先に呼ばれて instance が undefined になるので通常 no-op」と明記しており、responsibility が App.tsx に逆転している
- 同じリソース close ロジックが 2 箇所 (handleRemoveSubscriber と cleanupSubscriber) で実装されている

## 修正方針

1. `signals/subscriber.ts:removeSubscriber` を以下のように変更する:
   - Map から取得した `SubscriberInstance` の `decoder.value` / `session.value` を fire-and-forget でクローズしてから Map から削除する
   - Signal フィールドを null にリセットする (`decoder.value = null` / `session.value = null` 等)
2. `App.tsx:handleRemoveSubscriber` を `sub.removeSubscriber(id)` の呼び出しだけにする
3. `useSubscriber.ts:useEffect` cleanup は HMR 用の補助として残すが、コメント文を簡素化する

## 影響範囲

- `devtools/src/signals/subscriber.ts:removeSubscriber`
- `devtools/src/App.tsx:handleRemoveSubscriber`
- `devtools/src/hooks/useSubscriber.ts:useEffect` cleanup

## テスト戦略

- `vp run test` で全テストがパスすること
- `devtools/src/signals/subscriber.test.ts` に「`removeSubscriber` が decoder.close / session.close を呼ぶ」テストを追加 (偽の SubscriberInstance で検証)
- 手動: Remove ボタン → DevTools の Network タブで WebTransport 接続が確実に閉じること

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (devtools 内部 API の責務再編)

## 完了条件

- `removeSubscriber` 内で decoder / session が fire-and-forget close される
- `App.tsx:handleRemoveSubscriber` が `sub.removeSubscriber(id)` の呼び出しだけになる
- `useSubscriber` の cleanup と Two-Way の重複が解消されている
- 全テストパス
