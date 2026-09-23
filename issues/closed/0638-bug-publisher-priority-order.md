# Publisher Priority の大小と優先度の対応が仕様と逆になっている

- Created: 2026-09-21
- Completed: 2026-09-24
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

- `src/createMediaPublisher.ts` の優先度を仕様の向き (数値が小さいほど高優先) に合わせた。`PRIORITY_VIDEO_KEY` を 255 から 0、`PRIORITY_AUDIO` を 192 から 64 にし、`PRIORITY_VIDEO_DELTA` は §10.4 の既定と同じ 128 のまま据え置いた
- カタログの固定値 255 を `PRIORITY_CATALOG` (0) として切り出し、`publishCatalog` がそれを使うようにした
- `docs/HIGH_LEVEL_API.md` の Priority 節を「値が小さいほど優先度が高い」に直し、表に Catalog の行を足した。あわせて「Publisher Priority は Subgroup 単位で 1 つに決まるため、映像のデルタフレームはキーフレームで開いた Group の続きとして同じ Subgroup に載り、実際に送信される値はキーフレームの 0 になる。デルタフレームの 128 が載るのは、送信する Subgroup の先頭 Object がデルタフレームになるときだけである」を追記した
- devtools の `buildObjectSendPlan` の直書き値 (255 / 128) をライブラリの `PRIORITY_VIDEO_KEY` / `PRIORITY_VIDEO_DELTA` の参照に置き換え、テストの期待値・テスト名・コメントを追随させた
- テストは、定数値 (カタログ 0 / キーフレーム 0 / 音声 64 / デルタ 128)、大小関係 (カタログ ≤ キーフレーム < 音声 < デルタ)、`sendObject` に渡る値 (音声 2 フレーム・映像キーフレーム・映像デルタ)、`publishCatalog` が送る値の 4 つで固定した
- `CHANGES.md` の `## develop` 先頭に `[FIX]` を追記した

### 設計方針からの逸脱と、その理由

- 設計方針は「帯域不足時の動作 (デルタが最初に破棄され、Audio が維持され、キーフレームが可能な限り維持される) は意図どおりなので変えない」としていたが、キーフレーム 0 / 音声 64 の組ではワイヤ上で映像 Subgroup (0) が音声 (64) より高優先になり、「Audio は維持される」が成立しない。docs は実装の実効値に合わせて書き直した (映像キーフレームの Subgroup が最優先、Audio が次、デルタはキーフレームと同じ Subgroup に載るため個別には破棄されない)
- なお、デルタフレームに 128 が載るのは「送信する Subgroup の先頭 Object がデルタフレームになるとき」であり、差分先行のほかに、キーフレームより先にデルタが届いた場合・Forward State が 0 の間にキーフレームを送らなかった場合・キーフレームがエンコーダのキュー詰まりで符号化されなかった場合 (useWorker: false) を含む
- カタログの Priority は Subgroup Header に必ず明示値として載る (DEFAULT_PRIORITY ビットを立てない `FIRST_OBJ_EXT` を使うため)。受信側・購読側に数値の向きへ依存する判定は無いことを確認した

### 検証

- `npx vp check` / `npx vp test --run` (122 files / 2501 tests) が通る
- 変異テストで、定数を旧値に戻す / `publishCatalog` の値を戻す / 映像の値を音声と同じにする / デルタの値をキーフレームと同じにする / devtools を旧直書き値に戻す / 音声 2 件目だけ別の値にする、のいずれでも対応するテストが失敗することを確認した

## 残した課題

- 「同一 Group の 2 件目以降の priority 引数はワイヤに影響しない」契約 (Subgroup 単位で 1 つ) は `src/session/publish.prop.ts` の PBT でも固定されていない。同 PBT の生成器を拡張して、同一 Group で異なる priority を渡してもヘッダが先頭 Object の値のままであることを固定する余地がある
- デルタフレームを個別に破棄させたい場合は、デルタフレームを別 Group (1 フレーム 1 Subgroup) に分けるか Datagram にする設計変更が必要である。本 issue の範囲外
- `devtools/src/hooks/usePublisher.ts` のカタログ送信は priority を省略しており既定の 128 が載る。ライブラリのカタログ (0) とは異なる
- open issue の 0657 と 0679 が `publishCatalog` の現状を `priority: 255` と記述しているため、別途 refresh が必要
