# 音声 datagram の順序逆転の実測 (2026-10-26)

音声を datagram で受けるとき、順序逆転が実際に起きるのか、起きたときに再生へどう効くのかを
実リレーで測った記録である。計測用の仕込みと計器はこの計測のために追加した。

- 計測日: 2026-10-26 12:11〜12:24 (Asia/Tokyo)
- 接続先: `moqt://sora-moq.shiguredo.co.jp/`
- 条件: 各 60 秒、1 秒ごとに購読側の統計を採る。各条件 3 回
- 生データ: `investigation-logs/datagram-default-2026-10-26/` (gitignore 対象。計測後、
  条件名を付けて手動で整理した。spec は `investigation-logs/av-sync-samples-<timestamp>.jsonl`
  を書く)。表に使うのは各条件 run1〜run3 であり、`baseline-rerun1.jsonl` と
  `baseline-develop-control.jsonl` は環境確認のための追加の 2 回で表には含めない

## 目的

- Group が異なる Object の順序は保証されない (draft-ietf-moq-transport-22 §2.3.1)。音声は
  1 Object = 1 Group なので、これは datagram でも subgroup でも Object の順序が保証され
  ないことを意味する (draft-ietf-moq-loc-04 §4.1)。datagram では加えて再送されない
  (RFC 9221)。音声の受信側は到着順に復号するため、順序逆転した Object は逆順に鳴る可能性がある
  (`docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md`)。これまで実リレーでの発生は確認しておらず、
  計器も無かった
- 実際にどのくらい起きるのか、起きたときに jitter buffer と再生 (穴・遅延・A/V 同期) が
  どう反応するのかを、注入した条件と自然な条件で比べる

## 計測方法

devtools の既定 (Opus 48 kHz、音声の配送は Datagram、冗長度 2) で配信と購読を行った。
devtools はライブラリの高レベル API (`createMediaPublisher` / `createMediaSubscriber`) では
なく、低レベル API の Publisher / Subscriber を使う独立実装である。ここで測ったのは
datagram の transport 上の振る舞いであり、変更した高レベル API の既定経路の計測では
ない。仕込みはすべてページ側の `WebTransport` の datagram 読み出しに入れており、ライブラリの
実装には手を入れていない。

条件は次の 3 つである。

| 条件     | 仕込み                                                            |
| -------- | ----------------------------------------------------------------- |
| baseline | なし (経路任せ)                                                   |
| jitter60 | 受信する datagram を 0〜60 ms の一様乱数で遅らせる                |
| reorder  | Group を数え、50 個ごとの Group に属する全 copy を 40 ms 遅らせる |

reorder の仕込みは、datagram の wire (Type Flags → Track Alias → Group ID の MOQT varint、
draft-ietf-moq-transport-22 §8.1 / §11.2.1) から Group ID を読み、Group 単位で遅らせる。
既存の recovery 注入は「1 Object = 2 datagram」の組の並びを仮定しており、組の先頭がずれると
遅らせた copy が重複として捨てられて効かないことがあった (2026-10-25 の予備計測で同じ条件の
2 回のうち片方だけ効いた)。Group ID を読む形にして、copy の並びに依存しないようにした。

計器は devtools に追加した 3 つを使う (表の他の列は既存の library 統計である)。

- `duplicateObjectsDropped`: 冗長化の 2 個目以降を復号前に捨てた数
- `outOfOrderObjectsReceived`: 受信入口で、同じ購読の受信済み最大 Location より小さい
  Location で届いた Object の数 (同じ Object の copy は 1 回だけ数える。SUBSCRIBE_OK の
  LARGEST_OBJECT 以下の cache replay は除く)
- `maxOutOfOrderGroupDistance`: 順序逆転した Object が最大 Group から何 Group 戻っていたかの最大値
  (音声は 1 Object = 1 Group。moqt-js の Opus では 20 ms、AAC では 48 kHz のとき約 21.3 ms の目安)

## 結果

各 run の 60 サンプルから求めた値を 3 run の中央値にしたものである。定義は次のとおり。

- 受信数・`outOfOrder`・`duplicateObjectsDropped` は最初と最後のサンプルの差分 (約 59.4 秒)。
  `outOfOrder` の率は受信数の増分に対する割合
- `到着遅れ p95` は 1 秒ごとの `receiveDelayMs` (その時点で最後に届いた Object の遅れ) の p95
- `jitter 目標 p50` は `jitterTargetMs` の p50
- `鳴り始め p50 / p95` は 1 秒ごとの `startDelayMs.p50` の分布の p50 / p95 であり、
  鳴り始め遅延そのものの p95 ではない (この計測時点の raw data は `startDelayP50Ms` だけを
  持ち、p95 / max は計測後に spec へ追加した)
- `applied p95` は 1 秒ごとの値の p95。feedback の上限 160 ms に張り付いた値である
- 穴・圧縮・追いつきは 60 秒時点の累積値。追いつきは `catchUpStarts` の回数
- 最大距離は各 run の累積最大の 3 run 中央値 (jitter60 の 1 run は 11 だった)
- p95 は `sorted[floor(n * p)]` で求めた (この doc の定義。n = 60 なら 0 始まり 57 番目)

| 条件     | 受信数 | outOfOrder        | 最大距離 | 到着遅れ p95 | jitter 目標 p50 | applied p95 | 鳴り始め p50 / p95 | 穴               | 圧縮   | 追いつき |
| -------- | ------ | ----------------- | -------- | ------------ | --------------- | ----------- | ------------------ | ---------------- | ------ | -------- |
| baseline | 2975   | **0 (0.00 %)**    | 0        | 26.2 ms      | 100 ms          | 160 ms      | 154.2 / 157.5 ms   | 66 個 / 244.8 ms | 193 ms | 0        |
| jitter60 | 2974   | **810 (27.24 %)** | 7        | 113.7 ms     | 80 ms           | 160 ms      | 171.9 / 196.4 ms   | 48 個 / 361.3 ms | 250 ms | 11       |
| reorder  | 2976   | **57 (1.92 %)**   | 6        | 27.1 ms      | 100 ms          | 160 ms      | 144.4 / 177.5 ms   | 48 個 / 289.0 ms | 165 ms | 1        |

- `duplicateObjectsDropped` は 3 条件のすべてで受信数とほぼ同じだった (baseline の 3 回は
  2971 / 2975 / 2974、jitter60 は 2975 / 2975 / 2971、reorder は 2977 / 2976 / 2969)。
  冗長度 2 の 2 個目はほぼすべて経路上で届き、復号前に捨てられている
- baseline の 3 回はいずれも `outOfOrder` が 0 だった (合計 8,921 Object)。この経路では
  自然な順序逆転は観測されなかった
- reorder は 50 Group ごとの注入で、`outOfOrder` は 56〜59 件 (期待する 60 件前後) だった。
  最大距離は 6 Group で、40 ms (2 Group) の設定より大きい。遅らせた copy の `setTimeout` が
  遅れて発火する、または受信側の処理が詰まる分だけ戻り幅が広がると考えられる (この計測では
  原因を特定していない)
- jitter60 では Object の約 27 % が順序逆転した。jitter buffer は applied を上限の 160 ms まで
  広げたが、穴は 48 個 / 361.3 ms 残り、捨て (`playoutDrops`) は 0、追いつき (`catchUpStarts`) は 1〜14 回だった
- reorder と baseline の穴・圧縮・追いつきの差は、この計測では baseline のばらつきに埋もれて
  判別できなかった。順序逆転 57 件そのものの聴感への影響 (逆順再生の波形) は測っていない

## 環境についての注意

2026-10-26 の計測時間帯は、baseline でも `maxReceiveDelayMs` が 118 ms (3 回の中央値、最大 229 ms) まで上がり、
jitter 目標が 100 ms、applied が 160 ms、穴が 36〜82 個 / 60 秒出ていた。2026-10-25 20:02〜20:06 に
同じ仕様で採った baseline 4 回の中央値は `maxReceiveDelayMs` 61.8 ms、applied p95 105 ms
(p50 は 50 ms)、穴 8.5 個だった (最良の 1 回は 34.1 ms / 50 ms / 0 個)。
この差がコード変更によるものではないことを確かめるため、変更を外した develop の作業ツリーで
同じ baseline を 1 回採ったが、applied は p50 / p95 とも 160 ms (最終サンプルは 139 ms)、
鳴り始め 155.5 ms、穴 73 個 / 227.8 ms と同じ荒れ方をした。この時間帯の経路または relay の
状態によるものと考えられる。

このため、穴・遅延・A/V 同期の条件間の比較は、静かな時間帯での再計測が必要である。
`outOfOrder` / `duplicateObjectsDropped` は受信順だけを数えるため、playout / jitter buffer
の挙動の影響は受けない (baseline の 3 回は outOfOrder が 0 のままだった)。

## 判断

- 実リレーの自然な状態では順序逆転が 0 件だったため、**復号前の並べ替え窓を常設しない**。
  常設すると全音声に遅延が乗り、この計測では正当化できない
- 順序逆転した Object を無条件に捨てる防御も、今は入れない。実リレーでは発火せず、将来の fill / FETCH
  で回復した Object や、冗長化の 2 個目が遅れて届く形を壊す可能性があるためである。
  まず計器で観測を続け、自然な順序逆転が出た条件で聴感と穴の増加を確認してから決める
- `jitter60` は到着の揺らぎと順序逆転の両方を増やしており、どちらが再生の遅延と穴に
  効いたかは分離できていない。reorder 単独 (57 件) では差が出なかった。揺らぎへの備えは
  既存の jitter buffer の目標遅延が担っているが、今回の計測では applied が上限の 160 ms に
  張り付いても穴が残った
- 次にやること
  1. 静かな時間帯 (または有線) で baseline / jitter60 / reorder を各 3 回再測する
  2. reorder 条件で購読音声の波形を収録し、逆順再生による段差・無音が実際に出るかを見る
  3. devtools での実リレー計測で `outOfOrderObjectsReceived` が 0 でない場合に、破棄か
     並べ替え窓かを決める (この計器はライブラリの統計には無い)

## 再現

計測用の仕込みは `tests/e2e/relay/investigation-audio-delay.spec.ts` にある。

```sh
# baseline
MOQT_INVESTIGATION=1 MOQT_INVESTIGATION_SECONDS=60 MOQT_INVESTIGATION_REDUNDANCY=2 \
  vp exec playwright test --project=relay \
  tests/e2e/relay/investigation-audio-delay.spec.ts --grep "A/V 同期と音声の遅延の内訳"

# 揺らぎ (0〜60 ms)
MOQT_INVESTIGATION=1 MOQT_INVESTIGATION_SECONDS=60 MOQT_INVESTIGATION_REDUNDANCY=2 \
  MOQT_INVESTIGATION_JITTER_MS=60 \
  vp exec playwright test --project=relay \
  tests/e2e/relay/investigation-audio-delay.spec.ts --grep "A/V 同期と音声の遅延の内訳"

# 順序入れ替え (50 Group ごと、40 ms 遅らせる)
MOQT_INVESTIGATION=1 MOQT_INVESTIGATION_SECONDS=60 MOQT_INVESTIGATION_REDUNDANCY=2 \
  MOQT_INVESTIGATION_REORDER_EVERY=50 MOQT_INVESTIGATION_REORDER_MS=40 \
  vp exec playwright test --project=relay \
  tests/e2e/relay/investigation-audio-delay.spec.ts --grep "A/V 同期と音声の遅延の内訳"
```

`TEST_MOQT_URI` は `.env` から読まれる。計測結果は `investigation-logs/` へ JSON Lines で
書き出される (gitignore 対象)。

## 参照

- `tests/e2e/relay/investigation-audio-delay.spec.ts` の `installDatagramReorder`
- `devtools/src/utils/audioReceiveOrder.ts` の `AudioReceiveOrderTracker`
- `devtools/src/hooks/useSubscriber.ts` の `observeAudioReceiveLocation`
- `devtools/src/signals/statsSnapshot.ts` の `SubscriberAudioStats`
- `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md` (順序逆転と逆順再生の機序)
- `docs/AUDIO_FEC.md` (冗長化と、遅れて届く復旧の遅延推定への影響)
- refs/moq/draft-ietf-moq-transport-22.txt §2.3.1 / §6.2 / §8.1 / §8.2 / §11.2.1 / §11.5.2
- refs/moq/draft-ietf-moq-loc-04.txt §4.1
