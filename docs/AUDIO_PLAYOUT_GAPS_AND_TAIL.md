# 音声再生の無音の穴と末尾の欠落

2026-10-20 に `develop` (HEAD `4eb42b8a`) を対象として、実リレー経由の購読音声の出力波形を
収録し、「プチプチノイズ」と「最後が聞こえない」を再現して原因を特定した記録である。数値は
すべて実リレーの計測、または本番モジュールを直接駆動した再現による。測定に使った生データと
再現スクリプトは `investigation-logs/` (gitignore 済み) にあり、再現手順はこの文書の
「検証方法」に書く。方針の決定は `docs/AV_SYNC_DECISIONS.md`、これまでの遅延の計測は
`docs/AUDIO_PLAYOUT_LATENCY.md` にある。

## 前提

対象の構成は **Opus (48 kHz) + Datagram** とする。moqt-devtools の既定は音声のコーデックが
Opus、配送が Datagram、冗長度が 2 であり、実リレーの計測もこの構成で行った。音声は
1 Object = 1 Group = 1 Datagram であり、復号の出力は 20 ms のフレームになる。Datagram は
再送されない (RFC 9221) ため、損失と到着順の入れ替わりが起き得る。

ライブラリの高レベル API の既定は Subgroup 配送 (`AudioPublishOptions.delivery` の既定は
`"subgroup"`) であり、この文書の数値はその構成にはそのまま当てはまらない。Subgroup 配送では
Data Stream の再送と順序保証があるため、Datagram 固有の損失・順序の機序は起きない。

## 症状の再現

### プチプチノイズ

実リレー経由で devtools の購読音声 (ダミー音声の 440 Hz 連続トーン、映像あり、datagram、
冗長度 2) を 60.74 秒収録した。出力波形に次の穴と段差がある。

| 項目                                                                 | 実測                                                                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| デジタル無音 (ビット完全な 0) の区間                                 | 36 個 / 合計 149.0 ms / 最長 22.5 ms / 10 ms 以上 2 個                                                                                 |
| サンプル不連続 (1 階差分または 2 階差分がトーンの正常範囲を外れる点) | 90 件 / 60.7 秒。強度 p50 0.186 / 最大 0.298 (トーンの peak 0.305 と同程度)                                                            |
| 位相の飛び (440 Hz のゼロ交差間隔の外れ)                             | 0 件                                                                                                                                   |
| 同時刻の計器                                                         | `playoutCompressedMs` 180 ms、`playoutConcealedMs` 66 ms (`concealments` 2 回)、`playoutDrops` 0、`playoutRebases` 0、`missedFrames` 0 |

- 90 件の不連続は、すべて無音区間の両端で説明できる (36 個 × 2 端 = 72 件、検出下限未満の
  微小な無音 9 個 × 2 端 = 18 件、開始前の過渡 1 件)。波形を継ぎはぎしたのではなく、
  **鳴っている途中に 0 が挿入され、位相はそのまま戻る**形である
- 同じ AudioWorklet のタップで、ネットワークを介さず同じ AudioContext の 440 Hz を
  14.94 秒録る対照実験では、定常状態の無音も段差も 0 件だった。タップ経路は出力を
  欠落させないため、この穴は鳴らす側 (playout) の出力である
- 無音 149 ms は `concealedMs` 66 ms より多く、**計器に現れない穴**が含まれる

### 最後が聞こえない

| 停止の種類                 | 停止操作の後に音が出ていた時間 | 切られた予約済み音声                                        | 購読者の状態                 |
| -------------------------- | ------------------------------ | ----------------------------------------------------------- | ---------------------------- |
| 購読側の Stop              | +15.7 ms で停止                | **7 件 / 121.3 ms** (3 回の計測で 121.3 / 124.0 / 121.7 ms) | disconnected                 |
| publisher の stop-sending  | +179.3 ms                      | 0 件 / 0 ms                                                 | connected (購読は残る)       |
| publisher の close-session | +163.0 ms                      | 0 件 / 0 ms                                                 | connected (TRACK_ENDED のみ) |
| publisher の publish-done  | +233.7 ms                      | 0 件 / 0 ms                                                 | connected (TRACK_ENDED のみ) |

- 購読側の Stop では、目標遅延 (この計測では `appliedMs` = 100 ms) と 1 フレーム分の予約が
  残ったまま `AudioContext` が閉じられる。停止を押す直前に話された 0.12 秒が聞こえない
- 配信側の停止では購読側のセッションも `AudioContext` も閉じられず、受信済みのバッファを
  鳴らし切る。配信側の停止だけでは「最後が聞こえない」は起きない
- 配信側の capture から encode までの末尾は、単体ハーネスで 30 ms 欠ける (後述)。ただし
  実リレーの main thread 符号化では停止クリックの 118 ms 後まで encode が呼ばれており、
  実測では検出できなかった (encode 入力の総時間 17370 ms と、encode が呼ばれた壁時計の幅
  17307 ms の差は 0.36 %)。購読側の 0.12 秒に比べると小さい

## 機序

### 1. 無音の穴と境界の段差

`src/playout/audioPlayout.ts` の `AudioPlayoutScheduler.concealmentOf` は、二つの場合に
補間を返さない。

- 隙間が `AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS` (5 ms) 以下のとき。補間の継ぎ目が耳につくと
  いう理由で補間せず、無音のまま残す。実リレーで検出した 36 個のうち 27 個 (62.9 ms) と、
  検出下限未満の微小な無音 9 個 (約 10 ms) がこれに当たる
- 前の音の終わりが「今 + 余裕 (`AUDIO_PLAYOUT_MIN_LEAD_SECONDS` = 10 ms)」より過去のとき。
  補間バッファを過去に予約できないためである。36 個のうち 9 個 (合計 86.2 ms、5.8〜22.5 ms)
  がこれに当たる。アンダーランである

`src/playout/audioPlayoutSession.ts` の `AudioPlayoutSession.startBuffer` は、サンプルを
`createBuffer` と `copyToChannel` で詰めて `start(whenSeconds)` するだけで、バッファ境界の
フェードもクロスフェードも行わない。そのため補間しなかった隙間の前後は、440 Hz のトーンで
振幅の 60〜100 % の段差になる。これが聴感の「プチッ」に相当する。

`src/playout/audioPlayoutTimingStats.ts` の `AudioPlayoutTimingSnapshot` は、鳴らさなかった
音 (`backlog` / `catchUp` / `error` / `stopped`) だけを数え、鳴ったが無音だった区間、
境界の段差、予約の重なり、予約判断の後に `AudioContext.currentTime` が予約時刻を追い越した
回数を持たない。そのため 2026-10-16 の計測 (`missedFrames` 0、`concealedMs` 0) では、
このノイズを検出できなかった。

アンダーランが起きるのは、到着の揺らぎが目標遅延を超えるためである。実測の到着列の揺らぎは
p50 2.21 / p95 73.6 / p99 92.3 / 最大 110.5 ms であり、目標遅延は 80〜100 ms である。
NetEq と同じ 0.95 分位で目標を決める規則では、それを超える裾が穴になる。本番モジュールを
直接駆動した再現では、目標の深さを 86 ms にすると 60 秒で 24 回 / 162 ms のアンダーランが
入り、120.5 ms にすると 0 回になった (鳴り始めは +35 ms 遅くなる。適応の上限 160 ms の内側)。

### 2. media 時刻の飛び

Datagram は再送されないため、20 ms のフレームが 1 つ落ちると復号の出力が 1 つ欠ける。
WebCodecs の `AudioDecoder` には損失を通知する手段 (PLC) が無いため、欠けた 20 ms は
補間で埋めるしかない。`AudioPlayoutScheduler.schedule` は次の音を前の音の終わりに置くため、
補間が成功しなかった場合は無音の穴になり、成功した場合も補間の継ぎ目が残る。冗長度 2 で
2 回目が届けば救われるが、2 回目は遅れて届くため、到着の順序が入れ替わる。

media 時刻が飛ぶと、`schedule` は隙間 0 のまま内容だけを飛ばす場合がある。この境界にも
フェードは無い。合成信号での解析値は、440 Hz のトーンで 20 ms 飛びが peak の 113 %、
40 ms が 188 %、80 ms が 122 % の段差になる。今回の収録は損失が無く (`playoutDrops` 0、
`missedFrames` 0)、この形の不連続は観測されなかったが、損失のある経路では出る。

Datagram は到着順も保証されない。受信側は音声を到着順に復号へ渡し、並べ替えをしないため、
timestamp の順と逆に届くと、隙間 0 のまま内容だけが逆順に鳴る。実リレーでの発生は確認して
いないが、Datagram の仕様上は成立し得る。

### 3. 停止で切られる音

- 購読側: `src/createMediaSubscriber.ts` の `MediaSubscriberImpl.stop` は
  `AudioPlayoutSession.recordStopped` を呼んだ直後に `AudioContext.close()` する。
  `devtools/src/hooks/useSubscriber.ts` の `stopAudioPlayback` も同じである。予約済みの音は
  目標遅延 (100 ms) と 1 フレーム (20 ms) の分だけ先に積まれているため、その分が切られる。
  切った量は `missedByReason.stopped` に残るが、鳴らし切る処理は無い
- 復号前の遅延: `preDecodeDelayMs` が 0 より大きいとき、`MediaSubscriberImpl` の
  `disposeAllResources` が `audioPreDecodeStage.stop()` を呼び、`PreDecodeDelayStage.stop` は
  タイマーとキューを捨てる。保持中の Object は復号へ流れない。失われる量は最大で `delayMs`
  分である (2000 ms の設定で 20 ms の Object 3 件 = 60 ms を実測)。devtools も同じで、
  動的に遅延を 0 にしたときだけ `flush` する
- 配信側: `src/createMediaPublisher.ts` の `MediaPublisherImpl.stop` と `close` は
  `processingGeneration` を進めてから `disposeAllResources` を呼ぶ。`processAudioFrames` の
  1 フレーム先読み、停止直後に読んだフレーム、encoder に渡したが出力が返る前のフレームが
  送られない。単体ハーネスで 10 ms のブロック 3 つ分 = 30 ms を実測した (未読 1、世代不一致で
  符号化されない 1、符号化されたが出力が close の後で捨てられる 1)。`pause` は reader を
  cancel しないため 20 ms である
- Datagram の順序: 停止時に送った末尾の datagram は、PUBLISH_DONE (control stream) より後に
  購読者へ届き得る。購読者は PUBLISH_DONE を受けた時点で購読を closed にするため、後から
  届いた datagram は捨てられる (`src/subscriber.ts` の `SubscriberImpl.handleEnd` と
  `handleDatagram`)。実リレーの publish-done の計測では切られた予約は 0 件で観測されな
  かったが、control stream と datagram の間には順序保証が無く、経路の順序次第で起こり得る

## 否定した仮説

- 配信側の停止で購読側のセッションが切れ、`AudioContext` が閉じられる: 否定。close-session
  でも購読は connected のままで、TRACK_ENDED だけが届く
- 時間圧縮の継ぎ目がクリックになる: 否定。継ぎ目の段差は自然な差分以下で、実リレーの
  90 件への寄与は 0 件
- 波形を継ぎはぎした位相の飛び: 否定。ゼロ交差間隔の外れは 0 件で、穴の形は「無音が挟まる」
- 予約判断の後に `currentTime` が追い越したことによる重なり: 実機の long-task 記録は 0 件で
  未発生。ただし `createBuffer` の中で時計を 12 ms 進めると、600 フレーム中 22 回、41 ms の
  重なりが再現するため、機序自体は残る
- 過去時刻の `start()`: 否定。予約時刻は常に今 + 余裕以上へクランプされる
- 冗長化 2 回送りによる同じ音の二重再生: 否定。2 回目は復号へ渡る前に捨てられる
- catch-up の復号器作り直しで、破棄した旧 Worker の出力が交錯する: 否定。dispose の前に
  message handler が外れる
- 44.1 kHz で時間圧縮と補間が効かない: 既知の制限。Opus (48 kHz) の前提では該当せず、
  AAC の 44.1 kHz を使う場合の話である。ノイズではなく、遅れが固定され、欠落が無音になる

## 修正方針

優先度の高い順に示す。実装はまだ行っていない。

1. **計器を足す (最優先)**
   穴の回数・合計 ms・最大 ms と、予約できなかった穴の合計、境界の段差、予約の遅れと重なり
   を `AudioPlayoutTimingSnapshot` と `AudioStats` へ足す。E2E の判定と devtools の表示に
   載せる。これを入れないと、修正でノイズが減ったかを測定できない
2. **予約できる穴を埋める**
   5 ms の下限を下げ、予約できる隙間は補間か、隙間の長さに合わせた短いフェードで埋める。
   補間の継ぎ目が耳につく音では、無音より短いフェードの方がよい。全バッファ境界に一律の
   フェードを入れてはいけない (20 ms 周期の振幅変調になり、440 Hz で 50 Hz 間隔の側波帯が
   −26 dBc 立つ)
3. **予約できないアンダーランを減らす**
   事後には埋められないため、発生を目標遅延の閉ループ (`src/playout/audioDelayFeedback.ts`)
   へ入力し、圧縮だけでなく穴でも目標を上げる。実測の到着列では深さ 120.5 ms で穴が 0 に
   なる (遅延 +35 ms)
4. **media 時刻の飛びにフェードを入れる**
   1 フレーム先読みして、飛びを検出した境界の前後にフェードを掛ける (配信側の
   `src/audioSpliceFade.ts` と同じ考え方)。先読みの 20 ms は遅延に加算されるため、計器で
   効果を測ってから採否を決める
5. **停止時に鳴らし切る (購読側)**
   新規の受信と復号を止め、予約済みが鳴り終わるまで待ってから `AudioContext` を閉じる。
   復号前の段は stop ではなく flush して復号へ流す。待ち時間は最後に鳴り終わる時刻から
   現在までに余裕 (100 ms) を足し、0〜300 ms にクランプする。`MediaSubscriber.stop` は
   Promise を返すため待ちを追加できる。devtools の停止は同期関数なので、drain の完了を
   待つ非同期の停止と UI 表示が要る
6. **Audio Config の再構成中も Object を保持する (Opus 前提では対象外)**
   初期 configure 待ちと同じ保留キューへ積み、再構成の完了後に到着順で復号する。config が
   途中で変わるのは AAC を使う場合であり、この調査の前提 (Opus) からは外れる。コード上の
   欠陥として記録だけ残す
7. **配信側の末尾 (Opus + Datagram)**
   停止時に 1 フレーム先読みを encode し、Opus の encoder に残った入力を
   `AudioEncoder.flush` 相当で出力させる。WebTransport の datagram には送信完了の通知が
   無いため、残りの datagram を書いた後、PUBLISH_DONE を送る前にどれだけ待つか、末尾を
   冗長化するか、購読側で PUBLISH_DONE の後の短い猶予の間 datagram を受け付けるかを
   設計時に決める。draft-ietf-moq-transport-22 §11.3.2 の「閉じた Subgroup へ送らない」
   規則は Subgroup 配送の話であり、Datagram では「PUBLISH_DONE の後に届いた Object を
   購読者が捨てる」規則として読み替える

## 検証方法

- 単体: 本番モジュールを直接駆動し、穴・境界・media 飛び・停止の各条件を固定する。
  テストのログメッセージは日本語にする
- 実リレー: `tests/e2e/relay/investigation-audio-output.spec.ts` で購読音声を波形として収録し、
  デジタル無音と境界の段差を測る。`MOQT_INVESTIGATION=1` のときだけ動く調査専用の spec で
  あり、通常の CI では動かさない
- E2E の判定: 計器 (`playoutGapMs` など) を足し、実リレーの標準スイートで穴の量を判定する
- devtools: 統計に穴の回数・ms と、停止で切った量を表示する

## 残る不明点

- 実機のスピーカーで「プチプチ」と聞こえるかの確認はしていない。波形の段差からの推定である
- 静かな経路 (目標遅延 50 ms) での購読 Stop の切断量は測っていない。実測は目標遅延 100 ms の
  条件である
- Datagram の損失があるときの穴の量を測っていない。今回の収録は損失 0 相当であり、
  Opus の PLC を使えない状態で 20 ms のフレームが落ちたときに、補間で埋まる割合と、
  冗長度 2 で救える割合は未計測である
- PUBLISH_DONE と末尾の datagram の到着順が入れ替わる頻度は測っていない
- Dedicated Worker で符号化しているときの、停止時の encoder 入力と出力の差は測れていない
- 音声の到着順が timestamp 順と逆になる頻度は確認していない
- 15 分以上の単一セッションでの再現性は、この調査の条件 (最大 60.7 秒) では確認していない
- 実音声 (Opus で復号した声) での時間圧縮と補間の粗さの寄与は、合成信号の計測に留まる
