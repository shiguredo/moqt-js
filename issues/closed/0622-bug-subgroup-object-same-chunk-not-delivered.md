# SUBGROUP_HEADER と同じ chunk で届いた Object を FIN まで配信しない

- Created: 2026-09-19
- Completed: 2026-09-19
- Branch: feature/fix-subgroup-object-same-chunk-not-delivered
- Polished: {YYYY-MM-DD}

## 目的

Subgroup データストリームの読み出しループが、次の chunk を待ってから受信バッファを
処理している。SUBGROUP_HEADER と Object が同じ chunk で届くと、その Object は
次の chunk かピアの FIN まで配信されない。ピアが続きを送らない場合、Object は
DATA_STREAM_TIMEOUT (draft-ietf-moq-transport-21 §12.2) の期限まで届かず、
セッションが閉じて失われる。

subscriber は受信した Object をアプリへ渡すまでが責務であり、chunk の分割は
transport の都合で決まる。分割に依存して配信が遅延・欠落するのは仕様に反する。

## 現状

- `src/session/dataStreamIncoming.ts` の `dataStreamHandleIncomingStream` は
  SUBGROUP_HEADER をデコードし、消費しなかった残りを `initialPayloadBuffer`
  として `dataStreamHandleSubgroupStream` へ渡す
- `dataStreamHandleSubgroupStream` の subscriber mode のループは、先頭で
  `reader.read()` を await してから `buffer` を
  `dataStreamProcessSubgroupObjects` へ渡す
- このため `initialPayloadBuffer` に完成した Object が入っていても、次の chunk が
  届くまで `dataStreamProcessSubgroupObjects` が呼ばれない
- 期限まで次の chunk が届かないと `DATA_STREAM_TIMEOUT` でセッションが閉じ、
  Object は失われる。エラーメッセージは
  `data stream timed out waiting for the rest of a header or object: <N> bytes buffered`
  であり、N が「未処理のまま残った Object のバイト数」になる
- ピアが FIN を送れば `reader.read()` が解決し、溜まっていた Object がまとめて
  配信される。したがって FIN の有無で挙動が変わる

## 設計方針

- ループの順序を「処理してから待つ」に変える。`buffer` に取り出せる Object が
  ある間は `dataStreamProcessSubgroupObjects` を呼び、消費が進まなくなった
  (Object の途中までしか無い) 時点で `reader.read()` を待つ
- DATA_STREAM_TIMEOUT の期限は従来どおり「未処理バイトが残っている間だけ」張る
- FIN を検出しても、残バッファを処理し終えてからループを抜ける。FIN と同時に
  届いた最終 chunk を取りこぼさない
- ループを抜けた後に残バッファがあれば PROTOCOL_VIOLATION とする既存の判定は
  変えない (§11.3)
- pending mode (購読未登録) の経路は対象外とする。この経路は Object を
  デコードせずに溜めるだけで、同じ問題を持たない

## 完了条件

- SUBGROUP_HEADER と完成した Object を 1 つの chunk で届け、FIN を送らなくても
  Object が配信される
- SUBGROUP_HEADER と Object が別の chunk で届く場合も従来どおり配信される
- Object の途中までしか届いていない場合は次の chunk を待ち、揃った時点で配信する
- 上記を検証するテストがある
- `tsc --noEmit` / `vp check` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §11.3.1 (Subgroup Header)
- draft-ietf-moq-transport-21 §11.3 (Streams)
- draft-ietf-moq-transport-21 §12.2 (DATA_STREAM_TIMEOUT)

## 解決方法

### 読み出しループの順序を「処理してから待つ」に変更

`src/session/dataStreamIncoming.ts` の `dataStreamHandleSubgroupStream` の
subscriber mode のループを、次の chunk を待つ前に受信バッファを処理する形に変えた。

- `buffer` に取り出せる Object がある間は `dataStreamProcessSubgroupObjects` を
  呼ぶ。消費が進まなくなった時点で「Object の途中」と判断して `reader.read()` を
  待つ
- DATA_STREAM_TIMEOUT の期限は従来どおり未処理バイトが残っている間だけ張る。
  期限を張る位置は read の直前
- FIN を検出したら `finished` を立て、残バッファを処理し終えてからループを抜ける。
  FIN と同時に届いた最終 chunk を取りこぼさない
- ループを抜けた後に残バッファがあれば PROTOCOL_VIOLATION とする既存の判定は
  変えていない
- pending mode (購読未登録) の経路は Object をデコードしないため対象外

### テスト

`src/session.test.ts` に 2 件追加した。

- SUBGROUP_HEADER と完成した Object を 1 つの chunk で届け、FIN を送らなくても
  Object が配信されること
- SUBGROUP_HEADER と Object が別の chunk で届く場合も配信されること (分割到着を
  壊していないことの確認)

### 検証

- `npx tsc --noEmit`
- `npx vp check`
- `npx vp test --run` (2396 passed)
- `CHANGES.md` の `## develop` に [FIX] エントリを追加
