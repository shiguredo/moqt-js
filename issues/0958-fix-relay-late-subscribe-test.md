# 配信途中から購読する relay E2E で NEW_GROUP_REQUEST を要求する

- Created: 2026-11-13
- Completed: 2026-11-13
- Branch: feature/fix-relay-late-subscribe-test
- Polished: 2026-11-13

## 目的

`tests/e2e/relay/devtools-both-audio.spec.ts` の「配信の途中から購読しても、cache から配られた分を飛ばして live へ復帰する」が実リレーで常に失敗する。映像が 0 フレームのままで、テストの前提がリレーの挙動と合っていない。途中参加では publisher に新しい Group を要求し、テストが意図どおり通るようにする。

## 現状

- テストは配信を始めて 6 秒待ち、cache に映像と音声を溜めてから購読する
- 購読側は音声 (datagram) を 150 件以上受信して復号し、鳴っている。映像は `objectsReceived=0`、`framesDecoded=0`、`catchUpPending=true` のまま
- 配信側は計測中も映像を送り続けている (`framesEncoded` が 188 から 289 へ増加、符号化エラー 0)
- 購読は確立している (`decoderConfigured=true`)。クライアントの Group の保留は最初の Object を即座に通すため、保留に隠れているのではない
- 実リレー (公開環境) とローカルの sora-moq (ポートのみ変更) の両方で同じ結果になる
- ローカルの sora-moq の統計に `replay_subgroup_delivery_timeout_skipped` が出る。relay は cache の replay を OBJECT_DELIVERY_TIMEOUT (既定 5 秒、`fanout_object_delivery_timeout_ms`) で打ち切るため、6 秒前の映像の Subgroup は replay されない
- 音声は datagram で届き続けるため、この打ち切りの影響を受けない
- publisher (devtools) はキーフレームを要求されない限り新しい Group を始めないため、`keyFramesEncoded` は 1 のままである

## 設計方針

- 途中参加の購読では `NEW_GROUP_REQUEST=0` を要求する。devtools の購読オプション `NEW_GROUP_REQUEST` を有効にしてから購読する
- draft-ietf-moq-transport-23 §3.6 は、動的 Group 作成に対応する Track へ途中参加する購読の形として、Next Group の Location Filter と `NEW_GROUP_REQUEST=0` の組み合わせを挙げている
- テストの意図 (cache から配られた分を飛ばして live へ復帰する) は変えない。Group を新しく始めてもらうことで、映像の Subgroup が配信され、追いつきの判定を通せる

## 完了条件

- `tests/e2e/relay/devtools-both-audio.spec.ts` の全テストが実リレーで通る
- 公開環境とローカルの sora-moq の両方で通る
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

`tests/e2e/relay/devtools-both-audio.spec.ts` の「配信の途中から購読しても、cache から配られた分を飛ばして live へ復帰する」で、購読の開始前に `subscriber-new-group-request` のチェックボックスを有効にした。理由 (relay の cache replay は OBJECT_DELIVERY_TIMEOUT で打ち切られ、publisher は要求があるまで新しい Group を始めない) をコメントに残した。

確認:

- 公開環境 (`moqt://sora-moq.shiguredo.co.jp/`): 7 件すべて成功
- ローカルの sora-moq (ポートを 14433 に変更したもの): 修正前は同じテストが失敗し、修正後は成功 (`videoFrames=91`)
