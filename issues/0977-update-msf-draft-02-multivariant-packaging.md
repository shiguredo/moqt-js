# keyframeSpacing と multi-variant の publisher packaging を実装する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §4.3 は、alternate group 内でキーフレーム間隔が異なるトラックを配信する場合の publisher 要件を定める。Group はキーフレームで始まり 1 Group に複数キーフレームを置かないこと、alternate group 内で object 境界まで時間整合させること、各トラックに `keyframeSpacing` (§5.2.46) を MUST で持たせること、alternate group 内の開始 Group ID を一致させ以降 +1 で増やすことである。§5.2.46 は `keyframeSpacing` を「1 キーフレーム間隔あたりの Object 数」と定義し、購読側の切替点計算に使う。

現行実装は `altGroup` を catalog に出さず、開始 Group ID もトラックごとに独立に払い出す。`keyframeSpacing` も `maxGopDuration` も送出しない。単一バリアント配信しかしないなら §4.3 の適用条件を満たさないが、複数バリアントを配信する経路を作るなら同時に満たす必要がある。

## 現状

- `src/msf/types.ts` の `CatalogTrack` に `keyframeSpacing` が無い
- `src/codec/types.ts` の `MediaPublisherOptions` に `altGroup` を指定する口が無い
- `src/createMediaPublisher.ts` の catalog 生成は `renderGroup` と `targetLatency` だけを出し、`altGroup`、`maxGopDuration`、`keyframeSpacing` を出さない
- 同ファイルの `allocateInitialGroupId` は壁時計と単調ガードから開始 Group ID を払い出すため、音声と映像で値が異なる
- 映像のキーフレーム要求は経過時間 (`keyframeInterval`) で決まる。送信負荷で落としたフレームは Object として数えないため、1 Group あたりの Object 数は一定にならない
- 映像はキーフレームで新しい Group を開始するため、Group の先頭はキーフレームであり、Group 内に複数のキーフレームは入らない。ただし初回出力がデルタフレームだった場合は Group がデルタで始まり得る

## 設計方針

- `CatalogTrack.keyframeSpacing` を `number` として追加し、正の整数であることを検証する
- `MediaPublisherOptions` に `altGroup` を追加し、catalog に `altGroup` を出す
- `keyframeSpacing` を catalog に出す。値は「キーフレーム間隔あたりの Object 数」であるため、フレーム数ベースの間隔に変える必要がある。`keyframeInterval` (秒) は廃止するか、フレーム数指定に置き換える。API の破壊的変更は許容する
- 送信負荷で落としたフレームも Object ID の採番に含めるか、落とさない前提で `keyframeSpacing` を宣言するかを決める。落としたフレームを Object として数えない現行方針では `keyframeSpacing` を保証できないため、Group 内の Object ID をフレーム番号に対応させる
- alternate group 内で開始 Group ID を一致させる。`altGroup` を指定した track どうしは共通の開始値を使い、以降 +1 で増やす。単一バリアントの既存挙動を変えないよう、`altGroup` 未指定時は現行どおりトラック独立の払い出しを維持する
- Group の先頭がキーフレームであることを保証する。初回出力がデルタフレームの場合はキーフレームを要求してから Group を開始する
- object 境界での時間整合は、alternate group 内のトラックで同じ media time のフレームを同じ Object ID に置くことで満たす。音声と映像で境界が異なる場合は、alternate group の対象を映像だけに限定する運用を docs に書く

## 完了条件

- `keyframeSpacing` を持つ track を catalog に encode / decode でき、0 や負値を拒否する。単体テストで固定する
- `altGroup` を指定した publisher が catalog に `altGroup` を出し、開始 Group ID が同一の値になる。単体テストで固定する
- `keyframeSpacing` を宣言した track で、各 Group の Object 数が宣言値と一致する。単体テストで固定する
- `altGroup` 未指定時の開始 Group ID の払い出しが変わらない。既存テストが通る
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
