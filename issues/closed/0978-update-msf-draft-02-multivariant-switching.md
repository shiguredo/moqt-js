# Multi-Variant Fast Track Switching を実装する

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §6.3 は、alternate group 内でキーフレーム間隔が異なるトラック間の切替手順を新設した。帯域制約を満たす中で最も近い切替点を持つトラックを先に購読し (SHOULD)、再生開始後はより大きい `keyframeSpacing` を持つトラックへ有効な切替点で切り替えてよい (MAY)。切替点は、切替元の `keyframeSpacing` を S、切替先を T としたとき、切替元の Group ID G と Object ID N について `(G * S + N) / T` が整数になる点であり、その商が切替先で受信を始める Group ID になる。受信は Object ID 0 から始める。

現行実装にトラック切替の機能は無い。alternate group を使って静的に 1 トラックを選ぶだけで、再生中の切替は扱わない。

## 現状

- `src/mediaSubscriber/catalogSubscription.ts` の `extractTrackInfo` は catalog から音声と映像を 1 つずつ選ぶ。alternate group を使った選択はしない
- `src/msf/tracks.ts` の `getTracksByAltGroup` と `selectHighestBitrateTrack` などの選択 helper はあるが、切替に使われていない
- `src/groupSwitchGate.ts` は同一トラック内の Group 間の順序制御であり、トラック切替ではない
- `src/videoDecodeOrder.ts` は同一トラック内の Group と Object の順序判定である
- `src/session/publicTypes.ts` の `SubscribeOptions` に絶対開始の Location Filter (`startGroup` / `startObject`) がある。高レベルの購読はフィルタを渡していない
- `src/createMediaSubscriber.ts` は復号入力の位置 (Group ID / Object ID) を保持している

## 設計方針

- `createMediaSubscriber` に、alternate group 内のトラックを切り替える API を追加する。利用者が明示的に呼ぶ操作とし、自動 ABR は本 issue の対象外にする
- 切替点の計算を純関数として `src/msf/tracks.ts` に追加する。入力は切替元の `keyframeSpacing` と現在位置 (Group ID, Object ID)、切替先の `keyframeSpacing` とし、有効な切替点かどうかと、有効な場合の切替先 Group ID を返す
- 切替は「切替先トラックを絶対開始の Location Filter (`startGroup` に計算結果、`startObject` に 0) で SUBSCRIBE する」「切替先の最初のキーフレーム Object を適用した時点で旧トラックの購読を終了する」「復号器と再生の時間軸を引き継ぐ」の順で行う
- 切替先の catalog に `keyframeSpacing` が無い場合は切替を拒否する。§4.3 が alternate group 内の各トラックに MUST で要求しているため、無い catalog は仕様違反である
- 切替の途中で旧トラックの購読を先に閉じない。閉じると切替先のキーフレーム到着まで映像が途切れる
- 音声は切替対象外とする。alternate group の対象は映像だけにする

## 完了条件 (切替点の計算まで。購読の張り替えは別 issue)

- 切替点の計算を単体テストで固定する。`(G * S + N)` が `T` で割り切れる場合に切替可能、割り切れない場合に切替不可、商が切替先の開始 Group ID になる
- 切替後に切替先トラックを `startObject: 0` から購読する。単体テストで固定する
- 切替先の最初のキーフレーム Object まで旧トラックを維持し、その後で旧購読を終了する。単体テストで固定する
- `keyframeSpacing` の無いトラックへの切替を拒否する。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/tracks.ts` に `calculateTrackSwitchPoint` を追加し、draft-02 §6.3.2 の `(G * S + N) / T` が整数になるかを判定して切替先の開始 Group ID を返すようにした
- 切替元 / 切替先の `keyframeSpacing` は正の整数であることを検証する (§5.2.46)
- `src/msf.ts` と `src/index.ts` から公開した
- 購読の張り替えを高レベル API に組み込む作業は、範囲を分けて別 issue に切り出した。`switchVideoTrack` として、旧購読を維持したまま切替先を `startObject: 0` で購読し、最初のキーフレーム適用後に旧購読を解除する形を想定している
