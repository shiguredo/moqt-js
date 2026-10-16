# 音声のパケットロス対策: FEC の導入検討

音声は datagram (再送なし) で届き、いまは「同じ音声 Object を 1〜3 回重複送信し、受信側が 2 回目以降を捨てる」独自の冗長化で欠落に備えている。この方式を土台に、FEC (前方誤り訂正) 系の技術を入れてさらに安定させられるかを、実装の読解、一次情報 (RFC、仕様、実装ソース、論文)、ブラウザ実機での検証、数理モデルで検討した記録である。

- 調査日: 2026-10-16
- 冗長化の実装は `983a4c6c` (PR #492) でマージ済み。実測記録は `docs/AUDIO_PLAYOUT_LATENCY.md` と `docs/AUDIO_PLAYOUT_RESULT.md`、調査用の E2E は `tests/e2e/relay/investigation-audio-delay.spec.ts` にある。調査は `1f45eb40` を基準に行い、以下の行番号はこの版のものである
- 本文の数値は「実測」と「数理モデル」を明示して区別する。モデルの値は実測ではない

---

## 1. 結論

| 候補                                                    | 判定                                                                    | 理由 (要約)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opus in-band FEC (符号化器に冗長を埋め込む)             | **採用しない (現時点)**                                                 | 送信側は WebCodecs の入れ子 `opus` 辞書で有効にできる (chromium と firefox で実測、webkit は不可)。しかし受信側の WebCodecs `AudioDecoder` には FEC を使う手段が無く、Chromium の実装も常に `decode_fec = 0` である。冗長を載せても受信側で戻せない                                                                                                                                                                                     |
| アプリ層 FEC (XOR パリティ、Reed-Solomon)               | **単独では採用しない。パリティを 2 個置く RS だけが帯域を詰める次候補** | 独立損失で重複 2 回を帯域あたりでも回復力でも上回るのは、パリティを 2 個置く RS (k=3 m=2 / k=4 m=2) だけである (5 % 損失で RS k=3 m=2 は 0.0815 % / datagram 1.667 倍、重複 2 回は 0.2335 % / 2.000 倍)。XOR パリティ (k=2〜4) は帯域あたりで重複 2 回に劣る (k=2 で 0.4910 % / 1.500 倍)。5 連続のバースト損失ではどの FEC も重複送信を上回らない (重複 2 回 1.5750 % に対し RS k=3 m=2 は 1.5830 % で、しかも 2 フレームの遅延を払う) |
| 遅延を伴う冗長送信 (時間分散した冗長)                   | **未検証。実測が示す唯一のバースト対策**                                | 実測では「2 個目を 40〜100 ms 後に送る」と 5 連続バースト下の欠落が 1.6〜1.8 % から 0.1 % 前後へ下がった。しかし遅れて届く復旧の分が遅延推定を膨らませて棄却されている。修復用の冗長なら「復旧用」と明示できるため、この副作用を避けられる可能性がある                                                                                                                                                                                  |
| 配送方式を subgroup (再送あり) に切り替える             | **実測で比較すべき代替**                                                | 損失そのものが無くなる。代わりに head-of-line 遅延を払う (datagram を既定にして遅延の裾を縮めた経緯がある)。4.6 で扱う                                                                                                                                                                                                                                                                                                                  |
| バッファ (目標遅延) を広げる                            | **実測で比較すべき代替**                                                | 遅れて届く復旧を待てるようになる。実測では上限を 100 → 160 ms にすると時間圧縮は半減するが遅延が 20〜25 ms 増える。4.6 で扱う                                                                                                                                                                                                                                                                                                           |
| 既存の重複送信の改善 (復旧用マーカー、適応冗長度、計器) | **推奨 (第一段)**                                                       | 実装済みで実測もある。復旧用 copy を識別できるようにすれば、棄却された「間隔を空ける案」の副作用 (遅延推定の汚染) を消せる見込みがある                                                                                                                                                                                                                                                                                                  |
| fountain code (RaptorQ、RLNC)                           | 採用しない                                                              | ブロックが揃うまで復号できず、20 ms の粒には遅延が大きすぎる。実装コストも大きい                                                                                                                                                                                                                                                                                                                                                        |
| QUIC / WebTransport 層の FEC                            | 選択肢が無い                                                            | QUIC に FEC は無い。MoQ の draft 群にも FEC の規定は無く、MoQ WG は issue #320 で「MoQ Transport のスコープ外」と結論している                                                                                                                                                                                                                                                                                                           |

推奨する順序は次のとおり。

1. **計器と復旧用マーカーを入れる** (低コスト)。送信した copy 数、受信した重複数、復旧までの遅延を測れるようにし、冗長 copy を「復旧用」として受信側へ伝える
2. **間隔を空けた冗長を再評価する**。マーカーがあれば、棄却理由だった遅延推定の汚染を避けられる可能性がある。実測で最も効くのはこの案である
3. **帯域を詰めたければパリティ 2 個の方式 (RS k=3 m=2 相当) を試作する**。重複 2 回より少ない帯域で回復力も上回る (段階 2 の代替)。XOR パリティ 1 個 (k=2〜4) は帯域あたりで重複 2 回に劣るため候補にしない
4. Opus in-band FEC は、受信側が WebCodecs 以外 (ネイティブ実装、ゲートウェイ) になる構成で再検討する

---

## 2. 現状の把握

### 2.1 音声の配送

- 音声は 1 chunk = 1 Object = 1 Group で送る。`allocateAudioObject()` はフレームごとに Group ID を 1 進め、Object ID は常に 0 を返す (`src/createMediaPublisher.ts:172-184`)。`draft-ietf-moq-loc-04` §4.1 の例 (「each encoded audio chunk ... represents a MOQT Object」「there is one MOQT Object per MOQT Group」) に従っている
- フレーム長は WebCodecs の既定で 20 ms (`getAudioEncoderConfig()` は `frameDuration` を指定しない。`src/codec/config.ts:156-185`)。符号化は Opus で、サンプルレートとチャンネルの既定は 48 kHz / 2 ch (`src/codec/config.ts:8-9`)。ビットレートは必須で既定値が無く、実測は devtools の既定 64 kbps (`devtools/src/signals/connectionSettings.ts:236`) で行った
- 送り方は `delivery` で選び、ライブラリの既定は `"subgroup"` (`src/createMedia/settings.ts:113-115`)。Subgroup は Data Stream で再送されるため、実測されている冗長化の効果はすべて datagram 経路のものである
- datagram は再送されない (RFC 9221)。これが冗長化を配信側で行う理由である (`src/codec/types.ts:167-181`)

### 2.2 既存の冗長化

- 公開オプションは `AudioPublishOptions.redundancy?: number` (`src/codec/types.ts:182`)。1〜3 の整数、既定は 1。4 以上と 0 以下は `start()` がエラーにする (`src/createMedia/settings.ts:93-101`)
- 送信は `sendAudioFrameFireAndForget()` の datagram 分岐が唯一の実装である (`src/createMediaPublisher.ts:2037-2056`)。同じ Object (同じ Group ID、Object ID、payload、properties) を **間隔 0 で `copies` 回** `sendDatagram()` する

  ```ts
  const requestedCopies = this.resolvedAudio?.redundancy ?? 1;
  const copies = Math.min(3, Math.max(1, Math.floor(requestedCopies)));
  for (let copy = 0; copy < copies; copy++) {
    publisher.sendDatagram(datagram);
  }
  ```

- `delivery` が `"subgroup"` のときは `sendObject()` を 1 回だけ呼び、`redundancy` は読まれない (`src/createMediaPublisher.ts:2057-2059`)。指定してもエラーにならない
- 受信側は入口で `groupId` と `objectId` を `:` で繋いだ文字列をキーにし、直近 256 件の Set で 2 回目以降を捨てる (`src/createMediaSubscriber.ts:2261-2288`)。256 件は音声 50 Object/秒でおよそ 5.1 秒分である
- devtools は同じ規則を別実装で持つ (`devtools/src/hooks/useSubscriber.ts:278, 1595-1607`)。既定は devtools が 2 回、ライブラリが 1 回 (`devtools/src/signals/connectionSettings.ts:232`)

### 2.3 冗長化以外の欠落対策

- 補間: `concealSamples()` が直前の音の波形を繰り返して穴を埋める (`src/audioTimeStretch.ts`)。情報を復元するのではなく波形を作る処理である
- 追いつき: `AudioReceiveCatchUp` が復号の出力の遅れを見て復号器を作り直す (`src/audioReceiveCatchUp.ts`)。遅れの解消であり欠落の回復ではない
- 遅延推定: libwebrtc の NetEq を移植した `AudioDelayManager` が、500 ms 区間ごとの「基準からの最大の遅れ」をヒストグラムへ入れ、0.95 分位を目標遅延にする (`src/audioDelayManager.ts:195-222`)。窓はおよそ 25 件であり (実測の記録。`docs/AUDIO_PLAYOUT_LATENCY.md` の「遅れの推定は「窓ごとの最大」で決まる」)、**1 件の遅れで推定が動く**。目標遅延は 50〜100 ms で運用している (`src/audioDelayFeedback.ts:48`、`src/playbackTimeline.ts:145-154`)

### 2.4 実測されている効果と副作用 (origin/develop の docs より引用)

独立損失 `p` で `n` 回送ると、全ての copy が落ちる確率は `p^n` になる。実測 (実リレー、経路の損失を注入、30〜60 秒) はこの法則どおりである (`docs/AUDIO_PLAYOUT_LATENCY.md` の「2 回送りを既定にするかの判断」「損失が厳しい経路」)。

| 注入した損失 | 1 回送り (欠落率 / 鳴った割合) | 2 回送り        | 3 回送り       |
| ------------ | ------------------------------ | --------------- | -------------- |
| 0 %          | 0.001 / 99.3 %                 | 0.000 / 100.4 % | -              |
| 5 %          | 0.055 / 94.5 %                 | 0.003 / 99.4 %  | -              |
| 10 %         | 0.099 / 89.3 %                 | 0.009 / 96.9 %  | -              |
| 20 %         | 0.203 / 77.6 %                 | 0.037 / 96.3 %  | 0.010 / 99.4 % |

- 表の 0 % と 5 % は 40 秒の実測 (「2 回送りを既定にするかの判断」)、10 % と 20 % は 30 秒の実測 (「損失が厳しい経路」) である。同じ 10 % でも 40 秒側では 1 回 0.108 / 88.7 %、2 回 0.012 / 97.3 % であった。観測時間が違うため、行をまたいだ厳密な比較はしない

- 代価は帯域である。実測で 50 datagram/秒 → 100 datagram/秒、音声の帯域が 2 倍になる
- バースト損失では共倒れする。5 個連続で落とす注入 (全体 2 %) では、間隔 0 の 2 回送りでも欠落 1.6〜1.8 % が残った (`docs/AUDIO_PLAYOUT_LATENCY.md` の「まとめて落ちる経路 (バースト損失) と、2 個目を送る間隔」)

| 2 個目を送る間隔 | 欠落率         | 鳴った割合        | 復号器の作り直し | 飛ばした音   |
| ---------------- | -------------- | ----------------- | ---------------- | ------------ |
| 0 (続けて送る)   | 0.016 / 0.018  | 98.9 % / 98.6 %   | 6 / 9 回         | 480 / 560 ms |
| 2 (40 ms 後)     | -0.001 / 0.000 | 100.3 % / 100.6 % | 0 / 0 回         | 0 / 0 ms     |
| 5 (100 ms 後)    | 0.001 / 0.002  | 100.8 % / 100.7 % | 0 / 0 回         | 0 / 0 ms     |

- 間隔を空ける案は棄却されている。1 個目を失ったときに届く 2 個目が「遅れて届いた音」として遅延推定を膨らませ、損失の無い 60 秒の観測で揺らぎの推定が 20 ms → 80 ms、目標遅延が上限の 100 ms に張り付き、鳴り始めの遅れが 65 ms → 130 ms になった (交互に各 3 回でも再現)。TIMESTAMP の古さで除く案も、位置の順序で除く案も副作用を消せなかった

---

## 3. 既存方式の限界 (定量)

1. **帯域と datagram 数が冗長度に比例する。** 損失の無い経路でも常に `n` 倍である (`src/createMediaPublisher.ts:2051-2055`)
2. **連続送信のためバースト損失で共倒れする。** ほぼ同時に送る 2 個は同じ輻輳の山に乗る。独立損失を前提にした `p^n` 則は、この経路では成立しない
3. **冗長度が静的である。** `start()` で 1 度だけ解決し、実行中に変える API が無い (`src/createMediaPublisher.ts:677, 2051`)。経路の損失率に応じて自動で変える仕組みも無い
4. **受信側に「復旧用の copy」か「遅れて届いた本体」かを区別する手段が無い。** 判定材料は識別子だけで、`SendDatagramParams` に copy 番号や役割のフィールドが無い (`src/publisher.ts:138-168`)。2.4 の除外案が失敗した背景はここにある
5. **冗長化の効果を測る計器が無い。** 送信側統計は copy を数えず (`src/createMediaPublisher.ts:1881-1882`)、受信側統計は重複を除外した後に数える (`src/createMediaSubscriber.ts:2326-2332`)。「実際に何個送ったか」「重複が何個落ちたか」を公開統計から読めない

---

## 4. 候補ごとの評価

### 4.1 Opus in-band FEC — 実機で確かめた結果、受信側が使えない

**仕組み。** Opus は現フレームの中に直前フレームの低レートコピー (LBRR) を埋め込める (RFC 6716 §2.1.7)。追加パケットを送らず、符号化器の設定だけで冗長を持つ点が魅力である。ただし回復できるのは **直前 1 フレーム**に限られ、無音区間には付かず、モード遷移点では無効になる (RFC 6716 §4.2.2 / §4.2.4 / §4.2.5)。libopus は `packetlossperc` が 0 だと FEC を 1 ビットも生成しない (`decide_fec()`)。また CELT-only モードでは無効で、フルバンド 22 kbps 未満では **帯域を落として FEC の分を捻出する**。

**WebCodecs での指定方法。** `AudioEncoderConfig` の入れ子辞書 `opus` に `useinbandfec` と `packetlossperc` を置く (W3C の WebCodecs Opus 登録 §6.1)。**平らに置くと 3 ブラウザとも黙って無視される** (実機で確認。エコーにも現れず、ビットストリームも 1 バイト変わらない)。現行の `getAudioEncoderConfig()` はこの辞書を渡していないため、実効値は `useinbandfec = false` である。

**実機での結果 (chromium 156.0.8078.4 / firefox 157.0 / webkit 27.2、WebCodecs を直接実行)。**

| 確かめたこと             | 結果                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入れ子 `opus` 辞書の反映 | chromium と firefox は反映 (64 kbps で chromium は 16421 → 11022 バイト、firefox は 25512 → 10974 バイト。ともに CELT から Hybrid へモードが変化)。webkit はエコーするがビットストリームが 1 バイトも変わらない |
| 辞書の妥当性検査         | chromium は「Opus Ogg format is unsupported」「packetlossperc ... greater than 100」で拒否する。辞書が実際に解釈されている証拠である                                                                            |
| 復号側の FEC 利用        | 3 ブラウザとも欠落を伝える手段が無く、欠落させたフレームに対応する出力は 0 件                                                                                                                                   |

**決定的な問題は受信側にある。** WebCodecs の `AudioDecoder` には `decode_fec` に相当する指定が無い。Chromium の `media/filters/opus_audio_decoder.cc` は `opus_multistream_decode_float(..., 0)` と **常に 0 を渡している** (取得元: `https://chromium.googlesource.com/chromium/src/+/main/media/filters/opus_audio_decoder.cc`)。RFC 7587 §3.3 は「受信側で FEC を使えないなら FEC を送るべきではない (SHOULD NOT)」と明記しており、現状の構成はこれに該当する。Firefox と WebKit の内部実装は未確認だが、API 面で欠落を伝える手段が無い以上、期待できない。

**副次的な問題。** FEC を有効にすると符号化器が CELT-only から Hybrid (SILK+CELT) へモードを変える (実測)。音質とビットレート配分が変わるため「無料で冗長を足す」話ではない。

**判定。** 現行のブラウザ同士の経路では採用しない。受信側が WebCodecs 以外になる構成 (ネイティブ実装、RTP へのゲートウェイ) では再検討の価値がある。

### 4.2 アプリ層 FEC (XOR パリティ、Reed-Solomon) — 帯域効率は良いがバーストに弱い

**仕組み。** 複数の音声 Object からパリティ Object を作り、別の datagram として送る。受信側は欠落した Object を XOR 演算で戻す (1 パリティなら 1 個まで、Reed-Solomon なら m 個まで)。

**in-band FEC との決定的な違い。** 復元されるのは Opus のペイロードそのものであり、ビット単位で完全である。復号経路は WebCodecs のままでよく、受信側に復元機構を足すだけで動く。4.1 の「受信側が FEC を使えない」問題が無い。

**数理モデルの結果 (20 万フレーム 1 回、固定シード。実測ではない)。** 値は標本値であり、標準誤差は rs_k3m2 で ±0.006 % ポイント (相対 8 %)、dup2 で ±0.011、xor2 で ±0.016 である。閉形式の厳密値は rs_k3m2 が 0.0701 %、xor2 が 0.4875 %、dup2 が 0.2500 % で、別の乱数による 200 万フレームの試行もこれに一致した。

| 方式                        | 独立損失 5 % (復元不可 / datagram 倍率) | バースト 5 連続・全体 2 % (復元不可 / datagram 倍率) | 原理的な追加遅延   |
| --------------------------- | --------------------------------------- | ---------------------------------------------------- | ------------------ |
| 重複 1 回 (現状の既定)      | 5.0685 % / 1.000                        | 1.9935 % / 1.000                                     | 0                  |
| 重複 2 回 (devtools の既定) | 0.2335 % / 2.000                        | 1.5750 % / 2.000                                     | 0                  |
| 重複 3 回                   | 0.0120 % / 3.000                        | 1.1845 % / 3.000                                     | 0                  |
| XOR パリティ k=2            | 0.4910 % / 1.500                        | 1.7405 % / 1.500                                     | 1 フレーム (20 ms) |
| XOR パリティ k=4            | 0.9280 % / 1.250                        | 1.8600 % / 1.250                                     | 3 フレーム (60 ms) |
| RS k=3 m=2                  | 0.0815 % / 1.667                        | 1.5830 % / 1.667                                     | 2 フレーム (40 ms) |
| RS k=4 m=2                  | 0.1215 % / 1.500                        | 1.6625 % / 1.500                                     | 3 フレーム (60 ms) |

- 帯域は datagram の個数で数えている。バイト数で数えると XOR のパリティは詰め物の分だけ増え (xor2 で 1.508 倍、rs_k3m2 で 1.685 倍)、重複送信では両者が一致する。**方式の優劣の向きはどちらで数えても変わらない**
- 独立損失で重複 2 回を上回るのはパリティ 2 個の RS だけである。帯域あたりの復元不可率 (値 / datagram 倍率) は dup2 が 0.117、rs_k3m2 が 0.049、rs_k4m2 が 0.081 であるのに対し、xor2 が 0.327、xor3 が 0.533、xor4 が 0.742 で、**XOR パリティは重複 2 回に劣る**。XOR が重複 1 回より良いのは確かである
- バースト損失では FEC が勝てない。1 ブロックに 1 個しか冗長を置かない XOR は 5 連続で落ちると無力である。RS k=3 m=2 でも重複 2 回と同程度 (1.5830 % 対 1.5750 %) で、しかも 2 フレームの遅延を払う。帯域あたりでは重複送信が上回る
- 現行の重複送信は「パリティ無しで同じシンボルを n 回送る、消去符号の最も非効率な端点」と見なせる。独立損失に限れば、パリティ 2 個の RS に置き換える価値がある

**導入する場合に必要な設計 (未実装)。**

- 修復 Object を本体と区別する識別子。現行は 1 Group = 1 Object で Object ID が常に 0 であり、`allocateAudioObject()` は「同じ Group に本体と修復の 2 つを置く」形を作れない (`src/createMediaPublisher.ts:172-184`)
- 欠落の検出。Group ID の飛びが手がかりになるが、datagram は順序が保証されないため「欠落」と「入れ替わり」の区別が要る
- 受信側の復元機構と、修復 Object を復号へ渡さない分岐 (`src/createMediaSubscriber.ts:2285-2290` の間)。同じ規則が devtools にも別実装されているため両方を揃える
- 告知の方法。MoQ の draft 群に FEC の規定が無いため独自方式になる。Catalog は「知らないフィールドは無視する」と定められているため (draft-ietf-moq-msf-01 §5)、別トラックとして告知するのが最も安全である

### 4.3 遅延を伴う冗長送信 (時間分散) — 実測が示す唯一のバースト対策

2.4 の実測が示すとおり、バースト損失に対して効くのは「冗長を時間的に離して送る」ことである (欠落 1.6〜1.8 % → 0.1 % 前後)。棄却された理由は、遅れて届く復旧の分が遅延推定を膨らませることであり、方式そのものの効果ではない。なお古典的な interleaving (RFC 2354 §4.3) は「隣接する単位を送信列で引き離すよう並べ替える」方式であり、ここで扱う「2 個目の copy を遅らせて送る」とは別の技術である。

修復用の冗長には「本体ではなく復旧用である」ことを示せる (FEC のパリティ Object でも、役割を持たせた copy でもよい)。受信側は次の設計が取り得る。

- 修復用の冗長を遅延推定へ入れない (復旧が遅れたことは経路の揺らぎではない)
- 復元した Object は元の TIMESTAMP のまま再生の時間軸へ渡し、到着が遅れたことを「既知の復旧」として扱う

現行の実装では、同一 Object を送るだけなので受信側から見て 2 個目と遅着を区別できない (`src/createMediaSubscriber.ts:2261-2288`)。`SendDatagramParams` に役割のフィールドを足せば区別できるようになる。実装と実測はこれからである。

### 4.4 既存方式の改善 (推奨)

1. **復旧用 copy のマーカー。** `SendDatagramParams` に役割 (本体か復旧か) を持たせ、受信側で遅延推定から除外する。4.3 の前提でもある。既存の `redundancy` と同じく `AudioPublishOptions` の拡張で足りる
2. **適応冗長度。** 損失率に応じて 1〜3 を動かす。WebRTC は Opus を `useinbandfec=1` で登録し、Audio Network Adaptor が損失率と帯域の 2 軸のしきい値曲線 (有効化と無効化で別の曲線 = ヒステリシス) で FEC を on/off している (`modules/audio_coding/audio_network_adaptor/fec_controller_plr_based.cc`)。ただし MoQ には RTCP 相当が無いため、損失率は受信側の `datagramFramesReceived` と Group ID の飛びから推定してフィードバックする仕組みが要る
3. **計器。** 送信した copy 数、受信した重複数、復旧までの遅延を統計に足す (現状は 3 の弱点 5 のとおり読めない)
4. **優先度。** 冗長 datagram の publisher priority を本体より下げ、輻輳時に本体を守る (draft-ietf-moq-transport-22 §5.1.1 が優先度の意味とスケジューリングを、§10.4 が既定の publisher priority を定める)。ただし下げすぎると冗長が常に捨てられるため、実測で決める
5. **`delivery: "subgroup"` のときの `redundancy` を明示的に扱う。** 現状は黙って無視される。エラーにするか、警告を出す

### 4.5 採用しない候補

- **fountain code (RaptorQ、RLNC)。** RaptorQ は系統的符号であり、受信したソースシンボルはそのまま再生できる。ただし消失したシンボルの復元はブロックの K シンボルが揃うまで待つ必要があり、20 ms の粒には遅延が大きい (RFC 6330)。RLNC は復号そのものに待ちが要る。実装コストも大きい
- **QUIC / WebTransport 層の FEC。** QUIC に FEC は無い。MoQ の draft 群にも規定が無く (transport-22 では大文字の `FEC` は 0 件で、小文字まで含めた唯一の言及は §14.1.2 の帯域探索の文脈)、MoQ Transport の仕様に FEC を入れない方針が示されている (issue #320 に `NotTransport` ラベル。issue 自体は datagram の導入で解決として閉じられた)。QUIC の FEC 拡張 draft (`draft-michel-quic-fec-01`、`draft-zheng-quic-fec-extension-02`) はいずれも失効している
- **RED 型の同梱冗長 (前のパケットのコピーを同じ Object に載せる)。** WebRTC の音声 RED (`AudioEncoderCopyRed`) がこの形で、実装例はある。ただし現行の「1 chunk = 1 Object = 1 Group」の前提と衝突し、得られる回復力は重複 2 回と同じで、復旧に次のパケットを待つ 1 フレームの遅延が加わり、パケットあたりのサイズ上限 (libwebrtc は 1024 バイト) もある
- **Opus の DRED。** 直近の音声を低レートで持つ仕組みで、受信側の API 制約は in-band FEC と同じである (今回は検証していない)

### 4.6 配送方式とバッファ (FEC と同じ土俵の代替)

- **subgroup (再送あり) への切替。** ライブラリの既定は `"subgroup"` であり (`src/createMedia/settings.ts:113-115`)、Data Stream は再送されるため欠落そのものが無くなる。代わりに head-of-line 遅延を払う。datagram を既定にして遅延の裾を縮めた経緯があるため (`origin/develop` の実測記録)、損失のある経路でだけ subgroup へ戻す判断は、目標遅延 50〜100 ms との引き換えになる。**実測で比較すべき代替である**
- **バッファ (目標遅延) の調整。** 目標遅延の上限を 100 → 160 ms にすると時間圧縮が半減するが、遅延が 20〜25 ms 増える (実測)。遅れて届く復旧を待つ余裕を作る方向であり、A/V 同期の補償上限 (`src/playbackTimeline.ts:154`) との相談になる

---

## 5. 定量比較の読み方と限界

4.2 の表は数理モデルであり実測ではない。次の効果を織り込んでいない。

1. **輻輳の帰還。** 冗長を足すと帯域が増え、それ自体が輻輳を招いて損失を増やす。モデルは損失率を外から与えている
2. **バーストの切れ目。** モデルは時間軸を持たず、送信順に 5 datagram 連続で落ちると仮定するため、40 ms 後に送る 2 個目も同じバーストに入ってしまう。実測では間隔 40 ms で欠落がほぼ 0 になっており、**遅延を伴う方式についてモデルは悲観側に出る**
3. **順序とタイムアウト。** 到着は順序どおりと仮定し、パリティ到着前に再生位置が来る場合を考慮していない
4. **受信側の実装。** 表は「受信側に復元機構を実装した場合」の上限を与えるもので、現行の受信側は重複を捨てるだけである
5. **バイト数の見積もり。** Opus のフレーム長はブラウザ依存である (同じ設定で firefox は chromium の 1.3〜1.55 倍だった)

したがって 4.2 の表は、方式の優劣を「独立損失では FEC、バーストでは重複」という方向で判断するために使い、絶対値は実測で確かめる。

---

## 6. 推奨する次アクション

### 6.1 測定の道具立て

実リレー向けの既存 harness をそのまま使える (`tests/e2e/relay/investigation-audio-delay.spec.ts`)。

- 損失の注入: `installDatagramLoss(page, ratio, burstLength)`。環境変数 `MOQT_INVESTIGATION_LOSS` (割合) と `MOQT_INVESTIGATION_LOSS_BURST` (連続して落とす個数)
- 揺らぎの注入: `installDatagramJitter(...)`
- 指標: 欠落率、鳴った割合、飛ばした音、復号器の作り直し、目標遅延、鳴り始めの遅れ (devtools の統計から読む)

### 6.2 段階

1. **計器とマーカー (実装小)。** 3 の弱点 4 と 5 を解消する。この段階だけで「冗長度を上げて何バイト増え、重複が何個落ちたか」が読めるようになる
2. **マーカー付きの遅延を伴う冗長 (実装小)。** 2 個目を 40 ms 後 (実測で最も短い間隔) から試し、受信側が復旧用と判定して遅延推定から除外する。2.4 の棄却理由が消えるかを、同じ経路条件で対にして測る (損失 0 / 5 % / 10 %、5 連続バースト、各 30〜60 秒、交互に各 3 回)
3. **パリティ 2 個の方式 (RS k=3 m=2 相当、実装中規模)。** 段階 2 と同じ回復力がより少ない帯域で得られるか、そして遅延が増えても目標遅延の内側に収まるかを測る。修復 Object の識別子と欠落検出の設計が要る。XOR パリティ 1 個は帯域あたりで重複 2 回に劣るため候補にしない
4. **Opus in-band FEC は保留。** 受信側が WebCodecs 以外になるまで再検討しない

### 6.3 採用の判定基準 (案)

- 段階 2 または 3 が、5 % 損失で「鳴った割合 99.4 %」を維持しつつ、目標遅延と鳴り始めの遅れを悪化させないこと (現状は 65 ms 前後、上限 100 ms)
- 5 連続バースト (全体 2 %) で、欠落率を現行の 1.6〜1.8 % から下げること
- 帯域を増やす場合は、その分の回復力の改善を数値で示すこと (現行は 2 倍で `p^2`)

---

## 7. 未確認事項

1. **Opus in-band FEC を Firefox と WebKit が受信側で使うかは未確認である。** API 面で欠落を伝える手段が無いことは 3 ブラウザで確認したが、内部実装の確認は Chromium のみである
2. **WebKit の実測は Playwright の WebKit 27.2 による。** Safari そのものの挙動は未確認である
3. **FEC と重複送信を直接比較した査読研究は特定できなかった。** 最も近い一次情報は RFC 2354 §5 (修復方式の選択) である。文献探索は `web_search` が認証エラーで使えず、Crossref、Datatracker、GitHub API、`web_fetch` で代替したため、網羅的なサーベイではない
4. **本文を取得できなかった論文がある。** 書誌は DOI で確認したが、数値は引用していない (Bolot ら 1999 `10.1109/infcom.1999.752166`、Podolsky ら 1998 `10.1109/infcom.1998.665068`、Perkins ら 1998 `10.1109/65.730750`、Rizzo 1997 `10.1145/263876.263881` ほか)
5. **4.3 の「FEC の修復 Object なら遅延推定を汚さない」は仮説である。** 実装も実測もしていない
6. **実リレーでの FEC 方式の実測は未実施である。** 実装が必要であり、本検討の範囲外とした
7. **wire 上の 1 datagram あたりの実バイト数は未確認である。** 公開統計は payload と properties の合計のみで、MOQT と LOC のヘッダ分を含まない
8. **パリティ Object の詰め物のコストは見積もりである。** ブロック内の最大長に合わせると仮定した (実測の Opus フレーム長は最大 / 中央値 = 254 / 161 = 1.58 倍)

---

## 8. 出典

### 8.1 リポジトリ内

| 対象                   | 箇所                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 冗長化の実装 (送信)    | `src/createMediaPublisher.ts:2037-2056`                                                                                                                               |
| 冗長化の実装 (受信)    | `src/createMediaSubscriber.ts:2261-2288`                                                                                                                              |
| 冗長度の解決と検証     | `src/createMedia/settings.ts:87-117`、`src/codec/types.ts:182`                                                                                                        |
| 音声 Object の割り当て | `src/createMediaPublisher.ts:172-184`                                                                                                                                 |
| 遅延推定               | `src/audioDelayManager.ts:195-222`                                                                                                                                    |
| 音声の実測記録         | `docs/AUDIO_PLAYOUT_LATENCY.md` (「パケロス対策: 音声 Object の 2 回送り」「まとめて落ちる経路 (バースト損失) と、2 個目を送る間隔」)、`docs/AUDIO_PLAYOUT_RESULT.md` |
| 損失の注入 harness     | `tests/e2e/relay/investigation-audio-delay.spec.ts`                                                                                                                   |
| MoQ 仕様               | `refs/moq/draft-ietf-moq-transport-22.txt` §5.1.1、§10.4、§14.1.2、`refs/moq/draft-ietf-moq-msf-01.txt` §5、`refs/moq/draft-ietf-moq-loc-04.txt` §4.1                 |

### 8.2 標準

| 文書                                                                     | 引用した節                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| RFC 6716 (Opus)                                                          | §2.1.7 (in-band FEC)、§4.2.2 / §4.2.4 / §4.2.5 (回復できる範囲と限界)、§4.4 (PLC)                    |
| RFC 7587 (Opus の RTP ペイロード)                                        | §3.3 (受信側で使えないなら FEC を送らない)                                                           |
| RFC 2198 (RTP の冗長化)                                                  | §3、§4                                                                                               |
| RFC 5109 (汎用 FEC)                                                      | §3、§4、§5、§12 (Congestion Considerations)                                                          |
| RFC 8627 (FlexFEC)                                                       | §1、§1.1、§8                                                                                         |
| RFC 2354 (ストリーミングメディアの修復方式)                              | §4.2.1、§4.2.2 (メディア依存 FEC)、§4.3 (interleaving)、§5 (方式の選択)                              |
| RFC 6330 (RaptorQ) / RFC 6363 (FEC Framework)                            | 抄録                                                                                                 |
| RFC 9221 (QUIC の DATAGRAM 拡張)                                         | datagram が再送されないこと                                                                          |
| W3C WebCodecs Opus 登録                                                  | §6.1 (`OpusEncoderConfig.useinbandfec`、`packetlossperc`)                                            |
| draft-ietf-moq-transport-22                                              | §5.1.1 (優先度の意味とスケジューリング)、§14.1.2 (FEC の唯一の言及)                                  |
| MoQ WG issue #320 (`https://github.com/moq-wg/moq-transport/issues/320`) | `NotTransport` ラベルと FEC を仕様に入れない方針。issue 自体は datagram の導入で解決として閉じられた |

### 8.3 論文

書誌は DOI で確認した。**本文を取得できなかったものは数値の根拠に使っていない** (7 の未確認事項 4 を参照)。

| 文献                                                                                                                                                                                  | DOI                          | 読了     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------- |
| Perkins, Hodson, Hardman, "A survey of packet loss recovery techniques for streaming audio", IEEE Network 12(5):40-48, 1998                                                           | `10.1109/65.730750`          | 未確認   |
| Bolot, Fosse-Parisis, Towsley, "Adaptive FEC-based error control for Internet telephony", IEEE INFOCOM '99, 3:1453-1460                                                               | `10.1109/infcom.1999.752166` | 未確認   |
| Podolsky, Romer, McCanne, "Simulation of FEC-based error control for packet audio on the Internet", IEEE INFOCOM '98, 2:505-515                                                       | `10.1109/infcom.1998.665068` | 未確認   |
| Rizzo, "Effective erasure codes for reliable computer communication protocols", ACM SIGCOMM CCR 27(2):24-36, 1997                                                                     | `10.1145/263876.263881`      | 抄録のみ |
| Shih, Kuo, Shieh, Chou, "Small-block interleaving for low-delay cross-packet forward error correction over burst-loss channels", Int. J. Communication Systems 27(12):3980-3995, 2013 | `10.1002/dac.2593`           | 抄録のみ |
| Yajnik, Moon, Kurose, Towsley, "Measurement and modelling of the temporal dependence in packet loss", IEEE INFOCOM '99, 1:345-352                                                     | `10.1109/infcom.1999.749301` | 未確認   |
| Liang, Steinbach, Girod, "Real-time voice communication over the internet using packet path diversity", ACM Multimedia 2001                                                           | `10.1145/500203.500205`      | 未確認   |
| Fragouli, Le Boudec, Widmer, "Network coding: an instant primer", ACM SIGCOMM CCR 36(1), 2006                                                                                         | `10.1145/1111322.1111337`    | 未確認   |

### 8.4 実装ソース

| 対象                                                     | 取得元                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Chromium の Opus 復号器 (常に `decode_fec = 0`)          | `https://chromium.googlesource.com/chromium/src/+/main/media/filters/opus_audio_decoder.cc` |
| Chromium の Opus 符号化器 (`OPUS_SET_INBAND_FEC`)        | `https://chromium.googlesource.com/chromium/src/+/main/media/audio/audio_opus_encoder.cc`   |
| libopus の FEC 判定 (`decide_fec()`、`fec_thresholds[]`) | `https://raw.githubusercontent.com/xiph/opus/main/src/opus_encoder.c`                       |
| libwebrtc の Opus 既定 (FEC 有効)                        | `.../modules/audio_coding/codecs/opus/audio_encoder_opus.cc`                                |
| libwebrtc の適応 FEC (損失率ベース)                      | `.../modules/audio_coding/audio_network_adaptor/fec_controller_plr_based.cc`                |
| libwebrtc の RED (前パケットのコピー)                    | `.../modules/audio_coding/codecs/red/audio_encoder_copy_red.cc`                             |
