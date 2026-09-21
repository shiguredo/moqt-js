# Publisher Priority の大小と優先度の対応が仕様と逆になっている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publisher-priority-order
- Polished: 2026-09-21

## 目的

draft-ietf-moq-transport-21 §5.1.1 は「A lower priority number indicates higher priority; the highest priority is 0.」と定める。現状の値は数値が大きいほど高優先という前提で選ばれており、意図した優先順位がワイヤ上で逆になる。

## 現状

- `src/createMediaPublisher.ts` の `PRIORITY_AUDIO` は 192、`PRIORITY_VIDEO_KEY` は 255、`PRIORITY_VIDEO_DELTA` は 128。コメントも「音声は途切れると違和感が大きいため高優先」「後続フレームのデコードに必須のため最高」と、数値の大小を優先度の大小として説明している
- 同じファイルの `publishCatalog` はカタログ Object を `priority: 255` 固定で送る
- `docs/HIGH_LEVEL_API.md` の Priority 節は「値が大きいほど優先度が高く、帯域不足時に優先的に送信される」と説明し、Audio 192 / Video キーフレーム 255 / Video デルタフレーム 128 の表と「Video デルタフレームが最初に破棄され、Audio は維持され、Video キーフレームは可能な限り維持される」という帯域不足時の動作を載せる
- `src/createMediaPublisher.test.ts` の「Publisher Priority の定数はドキュメントの値である」が 192 / 255 / 128 を固定し、`devtools/src/hooks/usePublisher.test.ts` の「buildObjectSendPlan: キーフレームは優先度 255、デルタフレームは 128 にする」も同じ前提を固定している
- `devtools/src/hooks/usePublisher.ts` も 255 / 128 を直接書く (`PRIORITY_AUDIO` は `src/createMediaPublisher.ts` から import している)。devtools のカタログ送信は priority を省略するため既定の 128 が載る
- Publisher Priority は Subgroup Header にのみ載り、1 つの Subgroup の全 Object が同じ値になる (draft-ietf-moq-transport-21 §5.1.1)。音声は 1 フレームごとに Group を進めるため各 Object が 192 で送られる。映像はキーフレームで Group を進め、差分フレームは同じ Group (同じ Subgroup) に載るため、ワイヤに載る映像の値はキーフレームの 255 が実効値になり、`PRIORITY_VIDEO_DELTA` の 128 は最初のフレームが差分フレームのときにしか載らない。カタログは 255
- 結果として、意図 (キーフレームが最高、音声が次、差分フレームが最低) に対して、ワイヤ上は映像 255 が音声 192 より低優先になり、カタログ 255 と同じ最低側に並ぶ

## 設計方針

- 数値が小さいほど高優先 (§5.1.1) なので、キーフレーム < 音声 < デルタ の数値順にする (この不等号は数値の大小を指す)。§10.4 の既定 128 との関係は、差分フレームを既定と同じ 128 に据え置き、キーフレームと音声を既定より高優先 (128 未満) にする。具体的には `PRIORITY_VIDEO_KEY` を 0、`PRIORITY_AUDIO` を 64、`PRIORITY_VIDEO_DELTA` を 128 のままにする
- `publishCatalog` の固定値 255 は 0 (最高優先) にする。カタログはトラック構成を知らせる制御情報で、届かないと購読が始まらないうえ更新が稀なため
- `docs/HIGH_LEVEL_API.md` の Priority 節を「値が小さいほど優先度が高い」に直し、表に Catalog 0 の行を足す。帯域不足時の動作 (デルタが最初に破棄され、Audio が維持され、キーフレームが可能な限り維持される) は意図どおりなので変えない
- `src/createMediaPublisher.test.ts` の固定値テストと `devtools/src/hooks/usePublisher.test.ts` の期待値・テスト名・コメントを追随させ、`devtools/src/hooks/usePublisher.ts` の直書き値も揃える。devtools のカタログ送信 (priority 省略で 128) は本 issue では変更しない
- publish オプション (`PublishOptions.publisherPriority`) と DEFAULT_PUBLISHER_PRIORITY の扱いは変更しない。publish 経路は常に Subgroup Header へ実効値を書くため、Track Property の既定値との大小は今回の修正では観測できる差を生まない

## 完了条件

- ワイヤに載る Publisher Priority (音声の各 Group、キーフレームで開く映像の Subgroup、カタログ) が意図した優先順位と一致する
- 差分フレームの `PRIORITY_VIDEO_DELTA` は 128 のままで、キーフレームと音声より数値が大きい (低優先) ことをテストで固定する
- docs の表と説明、テストの固定値が仕様の向きに揃う

## 参照

- draft-ietf-moq-transport-21 §5.1.1 (優先度は 0-255 の符号無し整数。数値が小さいほど高優先で、最高優先は 0。1 つの Subgroup / Datagram は単一の Publisher Priority を持つ)
- draft-ietf-moq-transport-21 §10.4 (DEFAULT PUBLISHER PRIORITY は 0-255 で数値が小さいほど高優先。省略時は 128)

## 解決方法

{未着手}
