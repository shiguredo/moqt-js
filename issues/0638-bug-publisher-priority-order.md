# Publisher Priority の大小と優先度の対応が仕様と逆になっている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publisher-priority-order
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §5.1.1 は「A lower priority number indicates higher priority; the highest priority is 0.」と定める。現状の値は数値が大きいほど高優先という前提で選ばれており、意図した優先順位がワイヤ上で逆になる。

## 現状

- `src/createMediaPublisher.ts` の `PRIORITY_AUDIO` は 192、`PRIORITY_VIDEO_KEY` は 255、`PRIORITY_VIDEO_DELTA` は 128。コメントも「音声は途切れると違和感が大きいため高優先」「後続フレームのデコードに必須のため最高」と、数値の大小を優先度の大小として説明している
- 同じファイルの `publishCatalog` はカタログ Object を `priority: 255` 固定で送る
- `docs/HIGH_LEVEL_API.md` の Priority 表は「値が大きいほど優先度が高く、帯域不足時に優先的に送信される」と説明し、Audio 192 / Video キーフレーム 255 / Video デルタフレーム 128 を載せる
- `src/createMediaPublisher.test.ts` の「Publisher Priority の定数はドキュメントの値である」が 192 / 255 / 128 を固定している
- `devtools/src/hooks/usePublisher.ts` も 255 / 128 を直接書いて同じ前提を置く (`PRIORITY_AUDIO` は `src/createMediaPublisher.ts` から import している)
- 結果として、§10.4 の既定値と同じ 128 を使う Video デルタフレームが Audio 192 と Video キーフレーム 255 より高優先になる

## 設計方針

- 大小関係が「キーフレーム < 音声 < デルタ」になる値に変更する。§10.4 の既定 128 との関係 (既定より高優先にするか低優先にするか) を決め、定数と説明に揃える
- `publishCatalog` の固定値 255 も同じ規則で見直す
- `docs/HIGH_LEVEL_API.md` の Priority 表と「値が大きいほど優先度が高い」という説明を仕様の向きに直す
- `src/createMediaPublisher.test.ts` の固定値テストと、devtools の直書き値を追随させる

## 完了条件

- ワイヤに載る Publisher Priority の大小が意図した優先順位と一致する
- docs の表と説明、テストの固定値が仕様の向きに揃う

## 参照

- draft-ietf-moq-transport-21 §5.1.1 (優先度は 0-255 の符号無し整数。数値が小さいほど高優先で、最高優先は 0)
- draft-ietf-moq-transport-21 §10.4 (DEFAULT PUBLISHER PRIORITY は 0-255 で数値が小さいほど高優先。省略時は 128)

## 解決方法

{未着手}
