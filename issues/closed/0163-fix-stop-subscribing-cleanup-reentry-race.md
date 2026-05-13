# `stopSubscribing` と close コールバックの最終 `statusMessage` レースを解消する

Created: 2026-05-11
Completed: 2026-05-12
Model: Opus 4.7

## 概要

`stopSubscribing` の `await subscriberInstance.unsubscribe()` を待っている間に WebTransport の close コールバックが非同期で発火すると、`status.value` / `statusMessage.value` の最終値が呼び出し順に依存して非決定的になる。

issue #0150 で `cleanupSubscriber` 自体は冪等化済み (`session.value = null` を `sessionInstance.close()` の前に立てる修正)。残課題は **`status` / `statusMessage` の最終値の決定性** のみ。

## レースシナリオ

`useSubscriber.ts` 現実装で発生する順序例は以下のいずれか。

1. `stopSubscribing` 開始: `status = "disconnected"`, `statusMessage = "Disconnecting..."`, `isStopping = true` (l.587-589)
2. `await subscriberInstance.unsubscribe()` (l.594) で await
3. await 中に WebTransport が閉じ、`connect` 時に渡した close コールバック (l.231-238) が発火:
   - `status = "disconnected"`
   - `statusMessage = "Disconnected: closeCode=..., reason=..."`
   - `cleanupSubscriber()` を呼ぶ
4. `await unsubscribe()` が解決 (または reject)
5. `stopSubscribing` の finally (l.596-601):
   - `cleanupSubscriber()` を再度呼ぶ (2 回目は冪等)
   - `isStopping = false`
   - `status = "disconnected"`
   - `statusMessage = "Ready to subscribe"`

最終的に `statusMessage` は `"Ready to subscribe"`。close が `await unsubscribe()` 解決後・finally 完了後に発火した場合は `"Disconnected: ..."` で終わる。同じ「stop ボタン押下 → 同時にサーバ切断」操作でも実行ごとに表示が変わる。

## 根拠

- `useSubscriber.ts` l.231-238 (`connect` の close コールバック): `status` / `statusMessage` を直接書き換えてから `cleanupSubscriber()` を呼ぶ
- `useSubscriber.ts` l.239-243 (`connect` の error コールバック): `status = "error"` / `statusMessage = "Error: ..."` を書き換えてから `cleanupSubscriber()` を呼ぶ
- `useSubscriber.ts` l.550-554 (subscriber の end コールバック): `status = "disconnected"` / `statusMessage = "Stream ended"` を書き換えてから `cleanupSubscriber()` を呼ぶ
- `useSubscriber.ts` l.555-559 (subscriber の error コールバック): `status = "error"` / `statusMessage = "Subscribe error: ..."` を書き換えるのみ。**現状 `cleanupSubscriber()` を呼ばない**
- `useSubscriber.ts` l.581-602 (`stopSubscribing`): `await unsubscribe()` の前後と `finally` で `status` / `statusMessage` を書き換える
- `useSubscriber.ts` l.604-657 (`cleanupSubscriber`): `status` / `statusMessage` には触れない

## 修正方針

`status` / `statusMessage` の更新責務を一本化する。close / end / error の各コールバックは「stop 主導中の発火」または「`cleanupSubscriber` 通過後の遅延発火」では `status` / `statusMessage` を書き換えない。

### ガードの根拠 (2 段の必要性)

判定式は `!instance.isStopping.value && instance.session.value !== null` の単純 AND だが、`isStopping` のみ / `session.value === null` のみのどちらか単独ではカバーできないケースがある。

| シナリオ                                                                                            | `isStopping` 単独                 | `session === null` 単独                       | 両方 (AND)            |
| --------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------- | --------------------- |
| `stopSubscribing` 進行中 (`isStopping=true`)、`unsubscribe()` await 中で `cleanupSubscriber` 未実行 | 抑止可能                          | session 非 null のため抑止不可                | 抑止可能              |
| `stopSubscribing` finally 完了後 (`isStopping=false` に戻る)、close コールバックが遅延発火          | `isStopping=false` のため抑止不可 | 抑止可能 (`cleanupSubscriber` で null 化済み) | 抑止可能              |
| 非 stop 主導 (通常のサーバ切断 / Stream ended / Subscribe error)                                    | 抑止しない (期待挙動)             | 抑止しない (期待挙動)                         | 抑止しない (期待挙動) |

`isStopping` 単独 / `session === null` 単独はそれぞれ別の取りこぼしがあるため、両方の AND が必要。

### 既知の世代問題

`session.value === null` ガードは「現在の世代」と「前の世代」を区別しない。stop → start を素早く繰り返した場合、前世代の `stopSubscribing` 由来の遅延 close コールバックが次の start で代入された新世代 session を見て `session !== null` と判定し、抑止が効かないケースが理論上残る。

前世代の close コールバックが書き換える対象は世代非依存の `instance.status` / `instance.statusMessage` signal で、まさに本 issue の対象。`session.value === null` ガードでは前世代由来の遅延発火を新世代 session 代入後に区別できないため、UI 連打速度に依存して書き換えが漏れる。

恒久対応は issue #0161 の `AbortController` 化で、ローカル `signal` 参照経由で世代を分離する。0161 適用後はガード B (`session === null`) の世代問題は原理的に発生しない。本 issue は 0161 完成までの暫定対処として AND ガードを入れ、0161 と組み合わせれば世代問題も解消する。

### 0161 との統合ルール

0161 適用後は close / end / error コールバックから `cleanupSubscriber` (→ `teardownSubscriber`) 経由で `abort()` が走る設計のため、本 issue のガードで「ガード成立時はコールバック本体を early return」してしまうと `abort()` も走らなくなり進行中の `startSubscribing` が中断されない。

統合時のルール:

- 0161 単独適用の場合 (現状の本 issue 修正なし): 各コールバックは現状どおり `cleanupSubscriber()` を呼ぶ → `abort()` が走る
- 本 issue 単独適用の場合 (0161 なし): ガード成立時は early return し、`status` / `statusMessage` の書き換えと `cleanupSubscriber()` 呼び出しを両方スキップする (現状コードでは error コールバックは元々 `cleanupSubscriber` を呼ばないので影響なし、close / end コールバックは「stop 主導なら finally が cleanup を呼ぶ」「遅延発火なら既に cleanup 済み」で十分)
- 両方適用後: ガード成立時は `status` / `statusMessage` の書き換えのみスキップし、`abort()` 経路は維持する。具体的には「ガードによる early return ではなく、`status` / `statusMessage` の書き換え部のみを if ブロックで囲む」形に変える

### 具体的な変更

以下は **0161 適用後の最終形** を前提とする (本 issue 単独適用なら early return 形式でも構わないが、両方適用後は abort 経路を維持するため if ブロックで囲む)。

`useSubscriber` フック直下 (`startSubscribing` 定義より前、`renderFrame` / `handleObject` と同階層) に以下のヘルパーをクロージャとして定義する (export しない)。

```ts
const shouldApplyStatusUpdate = (): boolean => {
  return !instance.isStopping.value && instance.session.value !== null;
};
```

各コールバックの先頭で `if (shouldApplyStatusUpdate()) { ... status/statusMessage を書く ... }` のように書き換える。`cleanupSubscriber()` 呼び出し (close / end コールバックに存在) は条件外に出して常に実行する (0161 適用後の `abort()` 経路を維持するため、また現状の cleanup タイミング保証を変えないため)。

対象コールバック:

- `useSubscriber.ts` l.231-238 (`connect` の close): `status = "disconnected"` / `statusMessage = "Disconnected: ..."` を if 内に
- `useSubscriber.ts` l.239-243 (`connect` の error): `status = "error"` / `statusMessage = "Error: ..."` を if 内に
- `useSubscriber.ts` l.550-554 (subscriber の end): `status = "disconnected"` / `statusMessage = "Stream ended"` を if 内に
- `useSubscriber.ts` l.555-559 (subscriber の error): `status = "error"` / `statusMessage = "Subscribe error: ..."` を if 内に。`cleanupSubscriber()` は現状呼ばれていないので追加もしない

Catalog 購読側のコールバック (`useSubscriber.ts` l.301-307) は `status` / `statusMessage` を書き換えないため対象外。

非 stop 主導 (サーバ切断 / Stream ended / Subscribe error) のときはガード成立せず if 内処理が実行され、`cleanupSubscriber` も従来どおり呼ばれる。

選択基準: 「stop 主導 = ユーザー意図あり = `"Ready to subscribe"` で再購読待ち」「非 stop 主導 = 外因 = 詳細な終端理由を表示」という UX 上の意味付けを優先する。

### Publisher 側正常終了との切り分け

end コールバックの「Stream ended」は MOQT のフロー終了 (Publisher 側 SUBSCRIBE_DONE 等の正常終了) を意味し、必ずしも stop と直接対応しない。stop と Publisher 側終了がほぼ同時に起きた場合、本修正では Publisher 側終了の表示は `"Ready to subscribe"` で塗りつぶされる。stop 押下中はユーザー意図 (再購読待ち) を優先する UX 判断であり、Publisher 側終了の区別は本 issue では行わない。

## 関連 issue との順序

- issue #0150 (closed): `cleanupSubscriber` のリソース二重解放は解消済み。本 issue はその上位レイヤの状態表示レース
- issue #0161 (AbortController): 上記「0161 との統合ルール」参照。先後どちらでも実装可能だが、両方適用時は「ガードによる early return ではなく、書き換え部のみ if で囲む」形に揃える
- issue #0162 (リソース close を `removeSubscriber` に集約): 本 issue で触る部位 (コールバック内の status 更新) とは直交
- issue #0171 (`cleanupSubscriber` リネーム / 責務分割): リネーム後も本修正の対象 (コールバック内の if ガード) は同じ位置に残る。先後どちらでも実装可能

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts`
  - `connect()` に渡す close コールバック (l.231-238)
  - `connect()` に渡す error コールバック (l.239-243)
  - `session.subscribe()` に渡す end コールバック (l.550-554)
  - `session.subscribe()` に渡す error コールバック (l.555-559)
  - クロージャ内ヘルパー `shouldApplyStatusUpdate` の追加

## テスト戦略

`useSubscriber.ts` のコールバックはフック内クロージャで外から呼べないため、本 issue では自動テストを追加しない。`shouldApplyStatusUpdate` の判定は `!isStopping && session !== null` の 1 行で、export してテストする利益が乏しい。

手動確認:

- Stop ボタン押下と同時にサーバ側を切断するシナリオを 5 回繰り返し、最終 `statusMessage` が常に `"Ready to subscribe"` で確定すること
- 通常のサーバ切断 (stop ボタン未押下) では従来どおり `"Disconnected: closeCode=..., reason=..."` が表示されること
- 通常の connect エラー (stop 未押下) では `"Error: ..."` が表示されること
- Stream ended (Publisher 側正常終了、stop 未押下) では `"Stream ended"` が表示されること
- Subscribe error (stop 未押下) では `"Subscribe error: ..."` が表示されること
- Stop 押下中の close / end / error 発火では上記の詳細メッセージが `"Ready to subscribe"` で塗りつぶされること
- `vp run test` で全テストパス
- `vp run build:devtools` でビルド成功

## CHANGES.md 記載方針

`## develop` 直下に `[FIX]` で記載する (devtools の表示挙動を確定的にする修正、ユーザー可視)。

エントリ例:

```
- [FIX] devtools の `stopSubscribing` と close/end/error コールバックの最終 `statusMessage` レースを解消する (#0163)
  - @voluntas
```

## ブランチ命名

`feature/fix-` を使う。

## 完了条件

- `useSubscriber.ts` 内に `shouldApplyStatusUpdate` クロージャヘルパーが定義されている
- close / connect error / subscriber end / subscriber error の各コールバックで `status` / `statusMessage` の書き換えが `if (shouldApplyStatusUpdate())` 内に置かれている
- `cleanupSubscriber()` を元々呼んでいたコールバック (connect close / connect error / subscriber end) では、`cleanupSubscriber()` 呼び出しを if 条件外に置く (0161 適用後の abort 経路を維持)
- subscriber error コールバックは現状 `cleanupSubscriber()` を呼んでいないため、本 issue でも追加しない
- `stopSubscribing` 主導の終端時、最終 `statusMessage` が常に `"Ready to subscribe"` で確定する
- 非 stop 主導の終端時、従来の詳細メッセージ (`"Disconnected: ..."` / `"Error: ..."` / `"Stream ended"` / `"Subscribe error: ..."`) が保持される
- 手動確認シナリオ (上記 6 項目) が通過する
- `vp run test` で全テストパス
- `vp run build:devtools` でビルド成功
