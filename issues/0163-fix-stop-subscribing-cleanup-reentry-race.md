# `stopSubscribing` と close コールバックの最終 `statusMessage` レースを解消する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`stopSubscribing` の `await subscriberInstance.unsubscribe()` を待っている間に WebTransport の close コールバックが非同期で発火すると、`status.value` / `statusMessage.value` の最終値が呼び出し順に依存して非決定的になる。

issue #0150 で `cleanupSubscriber` 自体は冪等化済み (`session.value = null` を `sessionInstance.close()` の前に立てる修正)。そのため session / decoder の二重 close は発生しない。残課題は **`status` / `statusMessage` の最終値の決定性** のみ。

## レースシナリオ

`useSubscriber.ts` の現在の実装で発生する順序は以下のいずれか。

1. `stopSubscribing` 開始: `status = "disconnected"`, `statusMessage = "Disconnecting..."`, `isStopping = true` (l.587-589)
2. `await subscriberInstance.unsubscribe()` (l.594) で await
3. await 中に WebTransport が閉じ、connect 時に渡した close コールバック (l.231-238) が発火:
   - `status = "disconnected"`
   - `statusMessage = "Disconnected: closeCode=..., reason=..."`
   - `cleanupSubscriber()` を呼ぶ
4. `await unsubscribe()` が解決 (または reject)
5. `stopSubscribing` の finally (l.596-601):
   - `cleanupSubscriber()` を再度呼ぶ (2 回目は冪等)
   - `isStopping = false`
   - `status = "disconnected"`
   - `statusMessage = "Ready to subscribe"`

最終的に `statusMessage` は `"Ready to subscribe"` になる。逆に close が `await unsubscribe()` 解決後・finally 完了後に発火した場合は `"Disconnected: closeCode=..., reason=..."` で終わる。同じ「stop ボタン押下 → 同時にサーバ切断」操作でも実行ごとに表示が変わる。

なお `instance.isStopping` は `stopSubscribing` の二重実行防止 (l.584) と `startSubscribing` の入口ガード (l.217) にしか使われておらず、close コールバック内では参照されないため、レースの解消には寄与しない。

## 根拠

- `useSubscriber.ts` l.231-238 (connect の close コールバック): `status` / `statusMessage` を直接書き換えてから `cleanupSubscriber()` を呼ぶ
- `useSubscriber.ts` l.581-602 (`stopSubscribing`): `await unsubscribe()` の前後と `finally` で `status` / `statusMessage` を書き換える
- `useSubscriber.ts` l.604-657 (`cleanupSubscriber`): `status` / `statusMessage` には触れない (リソース解放と signal リセットのみ)
- issue #0150 (closed) で `session.value = null` の前倒し済み。`cleanupSubscriber` の冪等性は確保済み

## 修正方針

`status` / `statusMessage` の更新責務を一本化する。close コールバック側か `stopSubscribing` 側のどちらか一方を「権威」とする必要がある。

採用方針: **2 段ガードを併用する。**

- **ガード A (`isStopping`):** stop 主導中に発火するコールバックを抑止する
- **ガード B (`session.value === null`):** `cleanupSubscriber` 通過後に WebTransport から遅延発火する close コールバックを抑止する

ガード A は「stop 開始 〜 finally 完了」までを覆い、ガード B は「`cleanupSubscriber` で `session.value = null` が立った時点 〜 次の `startSubscribing` で再代入されるまで」を覆う。両者は重なり合うが目的が異なるので両方必要。

具体的に必要な変更は 2 点。

(a) `connect()` に渡す close コールバック (l.231-238) と Subscriber の end / error コールバック (l.550-559) の各々で、冒頭に以下のガードを置く:

```ts
if (instance.isStopping.value || instance.session.value === null) {
  // stopSubscribing 主導 (isStopping) または cleanupSubscriber 通過後の遅延発火
  // (session === null) なので status / statusMessage は確定済み。再書き換えしない。
  return;
}
```

`cleanupSubscriber` を呼ぶ責務もこのガード内では持たない (stop 主導なら finally が呼ぶ。遅延発火なら既に呼ばれ済み)。

(b) `cleanupSubscriber` 内では `status` / `statusMessage` には引き続き触れない (現状維持)。`stopSubscribing` の `isStopping = false` への戻しタイミング (finally 末尾) も現状維持。

`stopSubscribing` 側の `status` / `statusMessage` 更新は変更不要。`finally` 句の `"Ready to subscribe"` が常に最終文言として確定する。

非 stop 主導 (サーバ切断 / Stream ended / Subscribe error) のときは従来どおりコールバック側で `status` / `statusMessage` を更新し `cleanupSubscriber` を呼ぶ。

選択基準: 「stop 主導 = ユーザー意図あり = `"Ready to subscribe"` で再購読待ち」「非 stop 主導 = 外因 = 詳細な終端理由を表示」という UX 上の意味付けを優先する。`cleanupSubscriber` 内に「クリーンアップ済みフラグ」を入れる代替案 (issue 旧版) は、`status` / `statusMessage` の更新そのものは `cleanupSubscriber` の外側で行われるため解決にならず却下。`cleanupSubscriber` に `status` / `statusMessage` の更新責務を集約する代替案 (close 由来 / stop 由来の区別を放棄する) は UX を損なうため却下。

## 関連 issue との順序

- issue #0150 (closed): `cleanupSubscriber` のリソース二重解放は解消済み。本 issue はその上位レイヤの状態表示レース
- issue #0161 (AbortController 化): `startSubscribing` の中断シグナルを整理する。`stopSubscribing` のレースとは独立。先後どちらでも実装可能
- issue #0162 (リソース close を `removeSubscriber` に集約): `cleanupSubscriber` の close 部分の置き場所が変わる。本 issue で触る部位 (close / end / error コールバック内の status 更新) とは直交
- issue #0171 (`cleanupSubscriber` リネーム / 責務分割): リネーム後も本修正の対象 (close / end / error コールバック側の `isStopping` ガード) は同じ位置に残る。先後どちらでも実装可能だが、0171 を先に終えると衝突なく適用しやすい

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts`
  - `connect()` に渡す close コールバック (l.231-238)
  - `session.subscribe()` に渡す end コールバック (l.550-554)
  - `session.subscribe()` に渡す error コールバック (l.555-559)

## テスト戦略

CLAUDE.md 規約によりモック / スタブは使えない。現状 `useSubscriber.ts` のコールバックはフック内クロージャで外から呼べないため、まず以下のロジック抽出を行う:

- close / end / error コールバックの「`status` / `statusMessage` 更新と `cleanupSubscriber` 呼び出し可否」を判定する純粋関数 `shouldApplyTerminalUpdate(instance: SubscriberInstance): boolean` を `useSubscriber.ts` から export する
  - 実装は `return !instance.isStopping.value && instance.session.value !== null;` の 1 行
- 各コールバックの先頭で `if (!shouldApplyTerminalUpdate(instance)) return;` を呼ぶ

`devtools/src/hooks/useSubscriber.test.ts` に以下を追加:

- `createSubscriberInstance("test-id")` で実 `SubscriberInstance` を作成
- `isStopping = true` / `session.value = null` の組み合わせ 4 通りについて `shouldApplyTerminalUpdate` の真偽を assert する真理値表テスト (`false`, `false`, `false`, `true`)

これにより副作用関数 (コールバック本体) を抽出せずに、判定ロジックだけを純粋関数として隔離・検証できる。コールバック側は単純な `if` ガードのみなので、目視レビューと手動確認で十分。

手動確認:

- Stop ボタン押下と同時にサーバ側を切断するシナリオを 5 回繰り返し、最終 `statusMessage` が常に `"Ready to subscribe"` で確定すること
- 通常のサーバ切断 (stop ボタン未押下) では従来どおり `"Disconnected: closeCode=..., reason=..."` が表示されること
- Stream ended / Subscribe error 経路についても、stop 押下中は元の文言が抑止され、stop 未押下時は表示されること

`vp run test` で全テストがパスすること。

## CHANGES.md 記載方針

- `## develop` 直下に `[FIX]` で記載する (devtools の表示挙動を確定的にする修正)

## 完了条件

- `shouldApplyTerminalUpdate(instance)` が `useSubscriber.ts` から export されている
- close / end / error コールバック先頭で `if (!shouldApplyTerminalUpdate(instance)) return;` が呼ばれている
- `stopSubscribing` 主導の終端時、最終 `statusMessage` が常に `"Ready to subscribe"` で確定する
- 非 stop 主導の終端時、従来の詳細メッセージ (`"Disconnected: ..."` / `"Stream ended"` / `"Subscribe error: ..."`) が保持される
- `shouldApplyTerminalUpdate` の真理値表テスト (4 通り) がパスする
- `vp run test` の全テストがパスする
