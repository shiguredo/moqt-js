# トラック切替を高レベル API に組み込む

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §6.3 の切替手順は、切替先トラックを計算した Group の Object 0 から購読し、切替先の最初のキーフレームを適用した時点で旧トラックの購読を終了する。切替点の計算 (§6.3.2) は `calculateTrackSwitchPoint` として実装したが、高レベル API (`createMediaSubscriber`) には購読の張り替えを実行する経路が無い。現状は利用者が計算結果を `subscribe()` に渡して自前で張り替える必要がある。

## 現状

- `src/msf/tracks.ts` の `calculateTrackSwitchPoint` が §6.3.2 の式を実装している
- `src/session/publicTypes.ts` の `SubscribeOptions` に絶対開始の Location Filter (`startGroup` / `startObject`) がある
- `src/mediaSubscriber/trackSubscriptions.ts` の `subscribeTrack` はフィルタを受け取らないため、高レベルの映像購読は常に Next Object から始まる
- `src/createMediaSubscriber.ts` の `receiveVideoObject` は 1 つの映像購読を前提にしており、購読の差し替え時に `VideoDecodeOrder` / `GroupSwitchGate` / `GroupObjectOrderer` の状態を引き継ぐ経路が無い

## 設計方針

- `subscribeTrack` に `filter` を渡せるようにする
- `createMediaSubscriber` に `switchVideoTrack(trackName)` を追加する。catalog から切替先を解決し、`calculateTrackSwitchPoint` で開始位置を求めてから、旧購読を維持したまま切替先を購読する
- 切替先の最初のキーフレーム Object を受信した時点で旧購読を解除する。解除より先に旧購読を閉じると、切替先のキーフレーム到着まで映像が途切れる
- 復号器の再構成要否は codec と解像度の変化で判定する
- 切替先の catalog に `keyframeSpacing` が無い場合は切替を拒否する (§4.3 が alternate group 内の各 track に MUST で要求している)

## 完了条件

- `switchVideoTrack` で切替先を `startObject: 0` から購読する。単体テストで固定する
- 切替先の最初のキーフレームまで旧購読を維持し、その後で解除する。単体テストで固定する
- `keyframeSpacing` の無いトラックへの切替を拒否する。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
