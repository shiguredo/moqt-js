# Subscription と Fetch の定義追加に追随する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/update-subscription-fetch-definitions
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 で Subscription と Fetch の定義が追加・整理された。

- §1.3 に Subscription の定義が入り、§3.1 に "subscription-delivered" (Subgroup / Datagram で配送される Object) の語が導入された
- §3.2 の冒頭に Fetch の定義が入り、「FETCH は Start Location から End Location まで (inclusive) の既存 Object を要求し、省略時は {0, 0} と Largest Object が既定」と明記された。v21 は §3.2.1 Fetch State Management のみで導入定義が無かった

moqt-js の型・コメント・テストの用語を新しい定義に合わせ、実装の概念が仕様の定義とずれていないことを確認する。挙動変更は想定しない。

## 現状

- moqt-js のコメントは v21 の節番号 (§3.1 / §3.2.1 など) を参照している
- 「subscription-delivered」に相当する区別は `src/fetcher.ts` (FETCH 由来) と `src/subscriber.ts` (subscription 由来) の型・経路で表現されている
- Fetch の既定範囲について、`src/session/publicTypes.ts` の `FetchOptions.filter` のコメントに「省略時は {0,0} から Largest Object まで」と書かれている
- `src/session/params.ts` の `resolveFetchStartLocation` / `validateFetchOkEndLocation` が Fetch の開始・終了を扱う

## 設計方針

- コメント・JSDoc の用語と節番号を v22 §1.3 / §3.1 / §3.2 に合わせる ("subscription-delivered"、Established subscription など)
- `FetchOptions.filter` のコメントが v22 §3.2 の既定と一致していることを確認する
- 型や API の変更は行わない (定義の整理に追随するコメント更新のみ)

## 完了条件

- 用語と節番号の更新が完了している
- 挙動変更が無いことを既存テストで確認する
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §1.3 (Terms and Definitions) / §3.1 (Subscriptions) / §3.2 (Fetch)
- `src/session/publicTypes.ts` の `FetchOptions.filter` / `SubscribeOptions`
- `src/fetcher.ts` / `src/subscriber.ts` / `src/session/params.ts`

## 解決方法

{未着手}
