# 購読側の再生遅延 (復号前バッファ)

## 概要

高レベル API の購読側で、意図的に再生を遅らせる機能を `MediaSubscriberOptions.preDecodeDelayMs`
として提供する。2 秒以上の遅延を対象にし、ライブ配信を数秒遅らせて視聴する用途を想定する。

この遅延は「受信バッファのサイズ」を変える仕組みではない。受信した圧縮済み Object を復号へ
渡すまで時間で保持し、復号の開始を遅らせる仕組みである。受信バッファの上限は変更しない。

## 用語

| 名前                            | 何を決めるか                                        | 遅延を指定できるか       |
| ------------------------------- | --------------------------------------------------- | ------------------------ |
| `dataStreamMaxBufferBytes`      | 未完成の Object を保持してよいバイト数 (メモリ保護) | できない                 |
| `dataStreamMaxTotalBufferBytes` | 全データストリームの合計バイト数 (メモリ保護)       | できない                 |
| `pendingSubgroup`               | Track Alias 解決待ちの一時バッファ                  | できない                 |
| `pendingObjectQueue`            | 初期 configure 待ちの Object の上限                 | できない                 |
| `targetLatency`                 | catalog が宣言する表示遅延の下限                    | publisher が宣言する     |
| jitter buffer                   | 経路の揺らぎを吸収する適応的な再生遅延              | 間接的にだけ影響する     |
| `preDecodeDelayMs`              | 受信から復号までの追加遅延                          | 購読側が時間で指定できる |

## 受信バッファサイズではない理由

`ConnectOptions.dataStreamMaxBufferBytes` と `dataStreamMaxTotalBufferBytes` は、
draft-ietf-moq-transport-22 §12.5 の `EXCESSIVE_LOAD` に対応するメモリ保護の上限である。
未完成の Object の payload 全長を受けられる値を指定するものであり、超過したストリームは
打ち切られる。値を大きくしても、完成した Object をいつ復号するかは変わらないため、
再生遅延は制御できない。

また、バイト数はビットレートに依存する。同じ 2 秒でも 1 Mbps と 20 Mbps では 20 倍の差が
あり、「2 秒遅らせる」という指定をバイト数で表すことはできない。遅延は時間で指定する。

WebTransport のストリームを読まずに溜める方法も採らない。QUIC のフロー制御で転送が止まり、
relay の cache や再送の挙動に依存する。遅延を時間で安定して制御できず、受信側のメモリ上限も
バイト数では管理できないためである。

## 復号済みフレームを保持しない理由

`PlayoutBuffer` が保持するのは復号済みの `VideoFrame` である。2 秒の遅延をこれで実現すると、
1080p 30 fps で約 60 枚、60 fps で約 120 枚の `VideoFrame` を保持することになり、
1 枚あたり数 MiB のメモリが遅延に比例して増える。`JITTER_BUFFER_MAX_QUEUED_FRAMES` (24 枚) を
遅延に合わせて増やすと、同じ問題が大きくなる。

そこで、受信した圧縮済み Object を復号前に保持する。2 秒の遅延で保持するのは、例えば
20 Mbps の映像でも約 5 MiB であり、復号済みフレームを保持するより桁違いに小さい。
復号と表示の経路は遅延の分だけ後ろへずれるだけで、既存の jitter buffer と A/V 同期の
仕組みをそのまま使える。

## API

```typescript
interface MediaSubscriberOptions {
  // 受信した Object を復号へ渡すまでの追加遅延 (ms)。既定 0
  // 2 秒以上も指定できる。上限は MAX_PRE_DECODE_DELAY_MS
  preDecodeDelayMs?: number;
}

// moqt-js から import できる
import { MAX_PRE_DECODE_DELAY_MS } from "moqt-js";
```

- 未指定または 0 は追加遅延なしである。キューもタイマーも作らず、既存の経路をそのまま通す。
- 0 より大きい有限数で、`MAX_PRE_DECODE_DELAY_MS` 以下でなければならない。負数、`NaN`、
  `Infinity`、上限超過は生成時にエラーになる。
- 高レベル API の `MediaSubscriberOptions.preDecodeDelayMs` は生成時に固定する。購読中の
  動的変更は高レベル API では対象外である。moqt-devtools は共有の復号前の遅延の段
  (`PreDecodeDelayStage` / `SubscriberPreDecodeDelay`) を使って接続中にも変更できる (下記)。
- `MediaPublisherOptions` には無い。購読側だけの設定である。
- ワイヤフォーマット、MOQT のパラメータ、catalog、MSF のフィールドは変更しない。

## 動作

1. 受信した音声と映像の Object を、復号へ渡せる状態になった時刻にメディアごとの
   遅延の段へ積む。期限は `その時刻 + preDecodeDelayMs` である。
2. メディアごとに 1 本のタイマーが期限を待ち、期限が来た Object を積んだ順に復号へ渡す。
3. 復号の出力は遅延の分だけ後ろへずれる。`PlayoutTimeline` は「復号の出力の時刻 - TIMESTAMP」
   の最小値から基準の遅れを学習するため、`preDecodeDelayMs` は基準の遅れに含まれる。
4. 表示時刻は `TIMESTAMP + 基準の遅れ + 再生遅延` のままである。実際の表示遅延は、
   `preDecodeDelayMs` に経路と復号の遅れ、jitter buffer の遅延を加えた値になる。

遅延の起点は、初期 configure と Group の切り替えの保留を抜けて、復号へ渡せる状態になった
時点である。初期 configure が長引いた場合は、実際の遅延が指定値より長くなる。

映像の Group の切り替え (`GroupSwitchGate`) は受信時に今までどおり処理し、復号だけを遅らせる。
`subgroupEnd` も受信時に処理する。相対的な順序を変えないためである。

## 停止時の扱い

購読の停止時は、遅延の段に保持している音声 Object を flush して復号へ流す。ライブラリの
`MediaSubscriber.stop` は `PreDecodeDelayStage.flush` を呼んでから段を止め、flush した
Object の復号出力が予約されるまで待つ。そのうえで、予約済みの音が鳴り終わるまで待ってから
`AudioContext` を閉じる (drain)。待ち時間は「最後に鳴り終わる予約 - 現在 + 余裕 100 ms」を
0〜300 ms にクランプした値である。moqt-devtools も同じで、停止は drain の完了を待つ非同期
の処理になる。

停止時の切断量は計器で読む。切った量は `missedByReason.stopped`、drain で鳴らせた量・
切った量・待ち時間・flush した件数は `lastDrain` に残る。`close()` とピア起点の close も
drain するが、上限は 150 ms である。映像は drain の対象外であり、停止時に破棄する
(詳細は `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md` にある)。

## A/V 同期と受信側の追いつき

音声と映像の両方に同じ `preDecodeDelayMs` を適用する。2 つの復号の出力は同じだけ後ろへ
ずれるため、`PlayoutTimeline` の A/V 同期は今までどおり動く。保持上限を超えて一方の実効的な
遅延が短くなったときは、短縮量の大きい方へ両方を揃える (`synchronizePreDecodeDelayShorten` /
`SubscriberPreDecodeDelay`)。片方だけ短くなると表示時刻の基準がメディアごとにずれ、A/V 同期を
合わせられなくなるためである。短縮の同期は「これから積む Object」の期限にだけ効く。既に保持して
いる Object の期限は動かさないため、揃えた時点で一方の保持分がまとめて復号へ流れることはない。
復号へ渡す順序は積んだ順を守る。短縮で後から積んだ Object の期限が先に来ても、先頭の Object が
未期限の間は取り出さない。順序を入れ替えると音声の時刻が往復し、映像が欠落扱いになるためである。

`targetLatency` とは加算される。catalog が 100 ms を宣言しているときに 2,000 ms を指定すると、
表示遅延は約 2,100 ms 以上になる。総遅延を厳密に指定する値ではない。publisher の
`targetLatency` を変えられない場合、その分は上乗せされる。ただし `targetLatency` 側は jitter
buffer の遅延として `MAX_PLAYOUT_DELAY_MS` (500 ms) と表示待ちのキューの上限で切り下げられ、
切り下げた分は `avSync.targetLatencyLimitedMs` に出る。`preDecodeDelayMs` 側にはこの上限は
掛からない。

音声の受信側追いつき (`AudioReceiveCatchUp`) は、復号の出力の遅れから入力の遅れを引いた
「復号が足している遅れ」で判定する。意図した遅延をそのまま渡すと、復号器に 2 秒分が溜まって
いると誤判定する。そこで `AudioPlayoutRequest.intentionalDelayMs` と
`AudioReceiveCatchUpObservation.intentionalDelayMs` に `preDecodeDelayMs` を渡し、判定から
差し引く (moqt-devtools も同じ値を渡す)。

- `audio.playoutCatchUp.lagMs` は意図した遅延を含む。
- `audio.playoutCatchUp.decodeLagMs` は意図した遅延と入力の遅れを引いた値である。
- 意図した遅延を超えて実際に復号器が遅れた場合は、従来どおり追いつきが始まる。

## moqt-devtools での動的設定

moqt-devtools の Subscriber の設定画面に `Playback Delay (Audio + Video)` の select がある。
選択肢は Off / 500 / 1,000 / 2,000 / 3,000 / 5,000 / 10,000 ms であり、既定は Off である。この設定だけは
購読中も変更でき、変更は進行中の購読へ即座に反映する。

- 遅延を大きくすると、その時点から受信する Object が対象になる。保持中の Object の期限も
  新しい値で計算し直す。
- 遅延を小さくすると、保持中の Object の期限が早まる。0 にすると保持中の Object を
  待たずに復号へ流し、キューをやめる。
- 変更時は表示時刻の基準を取り直し、表示待ちのフレームも捨てる。基準の遅れは直近 10 秒の
  最小値であり、古い基準のままだと表示時刻が遅延の分ずれるためである。音声の追いつきの
  観測も消す。床 (直近の遅れの最小値) が古い遅延のまま残ると、変更後の最初の復号出力を
  復号器の詰まりと誤判定するためである。このため変更直後は一瞬 A/V の並びが変わる可能性が
  ある。
- URL クエリ `preDecodeDelayMs` で復元・共有できる。既定の Off は URL に載せない。
- 映像は受信時に到着を記録し、遅延後に復号する。音声は受信の遅れ (`audio.receiveDelayMs`) を
  到着時点で測り、遅延後に復号する。到着時点で測るため、`audio.receiveDelayMs` は遅延の分を
  含まない。入力の遅れとして追いつきの判定に使い、意図した遅延は `intentionalDelayMs` として
  別に差し引く。
- 高レベル API の `MediaSubscriberOptions.preDecodeDelayMs` と違い、生成時に固定しない。

## 保持上限と失敗時

- 保持上限はトラックごとに `PRE_DECODE_QUEUE_MAX_BYTES` = 64 MiB、
  `PRE_DECODE_QUEUE_MAX_OBJECTS` = 8,192 件である。
- 上限を超えたら古い Object から破棄する。新しい Object を破棄するとキューが埋まったままになり、
  以降の Object をすべて捨てることになるためである。
- 1 件だけでバイト上限を超える Object は保持しない。
- 古い Object を破棄したときは、残っている Object の期限を「保持できる時間」まで前倒しし、
  タイマーもその期限で張り直す。落とした分を遅延の短縮として吸収するためである。これをしないと、
  保持できる時間が指定した遅延より短い構成 (高いビットレートで長い遅延を指定した場合) では、
  先頭の期限が来る前に毎回破棄され、復号へ何も渡らなくなる。
- 短縮はキューが空になったら解除し、次の Object から元の遅延へ戻る。期限は各 Object を
  積んだ時点で決めて保持するため、短縮を時間で解消する方式と違って、保持中の Object の期限が
  時間と一緒に後ろへ動いて取り出せなくなることはない。
- 上限超過は購読期間あたりメディアごとに 1 回だけ通知する。高レベル API は `onError`、
  moqt-devtools は警告ログ (`addLog`) で通知する。通知には設定した遅延と実効的な遅延を含める。
  通知済みフラグは `close()` / `stop()` と再 start で解除する。
- 上限超過が続くと、指定した遅延より実際の遅延が短くなる。高いビットレートで長い遅延を
  指定するときは、この上限に注意する。短縮中は音声の追いつきの判定に使う「意図した遅延」も
  実際に保持した時間になる。
- 落とした Object にキーフレームが含まれると、次のキーフレームが届くまで映像を復号できない
  ことがある (既知の制限)。上限超過が起きる構成では `requestNewGroup()` で新しい Group を
  要求することを検討する。

## 開始時と経路の注意

- 購読を始めてから指定した遅延の分だけ表示が始まらない。2 秒を指定すると、最初の 2 秒間は
  映像も音声も出ない。
- 映像の購読が Group の途中から始まった場合は、キーフレームが届くまで復号できない。
  その待ち時間は遅延に上乗せされる。必要なら `requestNewGroup()` で新しい Group を要求する。
- relay の cache から古い Object がまとめて届く場合、既存の追いつきと同じく、古い内容が
  見えた後に追いつくことがある。この遅延機能はその挙動を変えない。
- バックグラウンドタブなどでタイマーが抑制されると、期限が遅れて表示がさらに遅れる。
  順序は保たれ、復帰後にまとめて処理される。
- `close()` / `stop()` は音声の保持中の Object を flush して復号へ流し、そのあとタイマーと
  キューを破棄する。flush の後に復号は走らない。映像は flush せずに破棄する。
- 映像デコーダーのエラー時と音声デコーダーのエラー時は、復号前の段も破棄する。古い入力を
  復号器へ渡して同じエラーを繰り返さないためである。音声の追いつきで復号器を作り直すときは
  破棄しない。段が保持しているのはこれから復号する直近の入力であり、捨てると指定した遅延の
  分だけ無音になる。

## 確認方法

- 表示遅延の合計: `getStats().avSync.presentationDelayMs`
- 遅延の内訳: `getStats().avSync.delays.*`
- 意図した遅延を含む音声の遅れ: `getStats().audio.playoutCatchUp.lagMs`
- 意図した遅延を除いた復号の遅れ: `getStats().audio.playoutCatchUp.decodeLagMs`
- 音声と映像の受信から表示までの時間: `audio.playoutTiming.*` / `video.playoutTiming.*`

2 秒指定時の値は、利用者要件から決めた目標であり、実リレーでの実測はまだ無い。実測するときは
`avSync.presentationDelayMs` が指定値の分だけ増えること、`decodeLagMs` が指定値に引きずられない
こと、`avSync.skewMs` が悪化しないことを見る。

キューの件数とバイト数は内部状態であり `getStats()` には出さない。上限超過は `onError`
(devtools は警告ログ) で分かり、件数とバイト数の上限そのものは単体テストで固定している。

## 採用しなかった案

- **受信バッファのサイズを大きくする**: 再生タイミングを変えられず、バイト数はビットレートに
  依存するため遅延を時間で指定できない。
- **`MAX_PLAYOUT_DELAY_MS` を 2 秒以上に上げる**: jitter buffer の遅延は復号済みフレームの
  キューが吸収する。フレームのメモリが遅延に比例して増える。
- **復号済みフレームのキューを増やす**: 映像 2 秒分の `VideoFrame` のメモリが大きすぎる。
- **ストリームの読み取りを止める**: QUIC のフロー制御と relay の cache に依存し、遅延を時間で
  安定して制御できない。
- **`targetLatency` を購読側で上書きする**: `targetLatency` は catalog の宣言であり、総遅延を
  指定する値ではない。既存の A/V 同期と音声の閉ループの意味を変えずに、加算する遅延として
  分けた。

## 制限と再考の条件

- 遅延の上限は 30 秒、保持上限はトラックごとに 64 MiB / 8,192 件である。これを超える用途は
  対象外とする。
- 高レベル API の遅延は生成時に固定する。接続中の変更は moqt-devtools だけで扱う。
- moqt-devtools の設定は選択肢から選ぶ方式であり、任意のミリ秒を入力する UI は無い。
- 指定値と実際の表示遅延の差を実リレーで測ったら、この文書に追記する。
- 保持上限に張り付く、またはタイマーの抑制が実用上問題になったら、上限とタイマーの扱いを
  見直す。
