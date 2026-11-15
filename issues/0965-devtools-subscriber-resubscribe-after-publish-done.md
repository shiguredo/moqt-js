# devtools subscriber が PUBLISH_DONE 後に SUBSCRIBE を張り直さない

- Created: 2026-11-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-subscriber-resubscribe
- Polished: {YYYY-MM-DD}

## 目的

publisher が PUBLISH_DONE で Track を終えた後、同じ Namespace で publisher が再び配信を始めたときに、devtools の subscriber がその Track を受信し続けられるようにする。

## 現状

2026-11-15 の別ノード構成での観測である。

- devtools の subscriber は SUBSCRIBE_TRACKS が既定で有効
- publisher が PUBLISH_DONE を送って Track を終えると、subscriber の per-track 購読は閉じる (draft-ietf-moq-transport-23 §3.1.1)
- publisher が同じ Namespace で再び PUBLISH しても、devtools の subscriber は通常 SUBSCRIBE を張り直さず、表示・再生が再開しない
- relay が SUBSCRIBE_TRACKS の結果 PUBLISH を再送しない構成では、subscriber 側から能動的に取得し直す必要がある

## 設計方針

- PUBLISH_DONE で閉じた Track について、subscriber が同じ namespace / Track 名を再度取得できるようにする。SUBSCRIBE_TRACKS の要求を維持したまま、必要なら通常 SUBSCRIBE を張り直す
- 自動再接続の範囲 (何回まで、どの間隔で) を決め、無限リトライにしない
- relay が PUBLISH を再送する場合と、通常 SUBSCRIBE を張り直す場合の両方を扱う。重複した PUBLISH と SUBSCRIBE で二重購読にならないようにする
- 再購読の失敗は購読単位のエラーとして表示し、セッション全体のエラーにしない
- 実リレーで、別ノード構成の publisher が PUBLISH_DONE → 再配信したときに、subscriber が再び受信できることを確認する

## 完了条件

- publisher の PUBLISH_DONE 後に再配信された Track を、devtools の subscriber が受信して表示・再生できる
- 二重購読や無限リトライが無いことを単体テストで固定する
- 実リレーでの確認結果を解決方法に記録する
- `vp check` と `vp test run` が通る

## 参照

- `devtools/src/hooks/useSubscriber.ts`
- `devtools/src/signals/subscriber.ts`
- `src/subscriber.ts` (handleEnd / onPublish)
- draft-ietf-moq-transport-23 §3.1.1 / §3.6 / §9.9
- 関連 issue: 0962、0964

## 解決方法

{未着手}

## 2026-11-16 の追記

- SUBSCRIBE_TRACKS が有効な場合、relay は publisher の再告知・再 PUBLISH を既存の購読へ再送することを実測した (harness / devtools の両方で新しい PUBLISH と Object を確認)。そのため「relay が再送しない」ことは原因ではない
- 本 issue の対象は、SUBSCRIBE_TRACKS を使わない通常 SUBSCRIBE の購読が PUBLISH_DONE で終了した後に、devtools が能動的に張り直さない経路に限定する。SUBSCRIBE_TRACKS が有効な経路は closed 0967 / 0970 の修正で復帰する
