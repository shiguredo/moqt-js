# 映像 track を切り替えても旧購読が残る

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

`0984` で追加した `switchVideoTrack` が、切替先の購読を確立した後に旧購読を解除していない。旧購読が残ると、同じ映像 track に 2 つの SUBSCRIBE が同時に存在し、Object の到着が二重になる。`MediaSubscriber` を停止するまでリソースが解放されない。

## 現状

- `src/createMediaSubscriber.ts` の `switchVideoTrack` は `trackSubscriptions.subscribeVideo` で切替先を購読するだけで、`trackSubscriptions.videoSubscriber` が指す旧購読を解除しない
- JSDoc には「旧購読は切替先の購読が確立した後に解除する」と書きながら、実装が無い
- `0984` の JSDoc に「§6.3.1 の切替先の最初のキーフレームまで旧購読を維持する手順は未実装」と書いていたが、§6.3.1 は切替点の track を購読する手順を定めるのみで、旧購読の維持は要求していない (MUST でも SHOULD でもない)

## 設計方針

- 切替前の `videoSubscriber` を保持し、切替先の購読が確立した後に `unsubscribe` する
- 解除の失敗は切替の失敗として呼び出し元へ伝える
- 「キーフレームまで旧購読を維持する」という記述は仕様に無いため削除する

## 完了条件

- 切替後に旧購読が解除される (コードで確認する)
- JSDoc が §6.3.1 の記述と一致する

## 解決方法

{未着手}
