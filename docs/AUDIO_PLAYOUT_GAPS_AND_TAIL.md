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

ライブラリの高レベル API の既定も Datagram 配送 (`AudioPublishOptions.delivery` の既定は
`"datagram"`) であり、Subgroup 配送は明示した場合に使う。この文書の数値は Datagram 配送の
構成で測ったものである。Subgroup 配送では Data Stream の再送があるため Datagram 固有の
損失は起きにくい (FIN で閉じる限り再送され、RESET された場合は欠落し得る)。音声は
1 Object = 1 Group = 1 ストリームであり、フレーム間の順序保証は元から無い。

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

- 90 件の不連続は、すべて無音区間の両端で説明できる (開始 36 件 + 終了 35 件 = 71 件。
  1 個の無音の終了端は収録の外にある。検出下限未満の微小な無音 9 個 × 2 端 = 18 件、
  開始前の過渡 1 件。合計 90 件)。波形を継ぎはぎしたのではなく、
  **鳴っている途中に 0 が挿入され、位相はそのまま戻る**形である
- 同じ AudioWorklet のタップで、ネットワークを介さず同じ AudioContext の 440 Hz を
  14.94 秒録る対照実験では、定常状態の無音も段差も 0 件だった。タップ経路は出力を
  欠落させないため、この穴は鳴らす側 (playout) の出力である
- 無音 149 ms は `concealedMs` 66 ms より多く、**計器に現れない穴**が含まれる

### 最後が聞こえない

以下の表は **drain (停止時に予約済みを鳴らし切る処理) を実装する前** の実リレー計測である。
既定値 (`preDecodeDelayMs = 0`) では、購読側の Stop で切られる予約は 0 件であり、実リレーで
3 回計測して確認した (`lastDrain` の鳴らせた量と `missedByReason.stopped`)。`preDecodeDelayMs`
を指定したときは、flush 分のうち上限までに鳴らし切れない分が切られる。未計測なのは目標遅延
50 ms の経路と実機スピーカーでの聴感だけである。

| 停止の種類                 | 停止操作の後に音が出ていた時間 | 切られた予約済み音声                                        | 購読者の状態                 |
| -------------------------- | ------------------------------ | ----------------------------------------------------------- | ---------------------------- |
| 購読側の Stop              | +15.7 ms で停止                | **7 件 / 121.3 ms** (3 回の計測で 121.3 / 124.0 / 121.7 ms) | disconnected                 |
| publisher の stop-sending  | +179.3 ms                      | 0 件 / 0 ms                                                 | connected (購読は残る)       |
| publisher の close-session | +163.0 ms                      | 0 件 / 0 ms                                                 | connected (TRACK_ENDED のみ) |
| publisher の publish-done  | +233.7 ms                      | 0 件 / 0 ms                                                 | connected (TRACK_ENDED のみ) |

- 購読側の Stop では、目標遅延 (この計測では `appliedMs` = 100 ms) と 1 フレーム分の予約が
  残ったまま `AudioContext` が閉じられていた。停止を押す直前に話された 0.12 秒が聞こえない。
  drain を入れた後は、停止の要求で新規の受信と復号を止め、予約済みの音が鳴り終わるまで
  待ってから閉じるため、この 0.12 秒は鳴る (上限の 300 ms を超えた分だけが切られる)
- 配信側の停止では購読側のセッションも `AudioContext` も閉じられず、受信済みのバッファを
  鳴らし切る。配信側の停止だけでは「最後が聞こえない」は起きない
- 配信側の capture から encode までの末尾は、単体ハーネスで 30 ms 欠ける (後述)。ただし
  実リレーの main thread 符号化では停止クリックの 118 ms 後まで encode が呼ばれており、
  実測では検出できなかった (encode 入力の総時間 17370 ms と、encode が呼ばれた壁時計の幅
  17307 ms の差は 0.36 %)。購読側の 0.12 秒に比べると小さい

## 機序

### 1. 無音の穴と境界の段差

以下は修正前 (`develop` `4eb42b8a`) の機序である。現在は下限を 0.5 ms まで下げ、予約できる
未来の分は補間する (後述の修正方針)。

`src/playout/audioPlayout.ts` の `AudioPlayoutScheduler.concealmentOf` は、二つの場合に
補間を返さない。

- 隙間が `AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS` (修正前は 5 ms) 以下のとき。補間の継ぎ目が
  耳につくという理由で補間せず、無音のまま残す。実リレーで検出した 36 個のうち 27 個
  (62.9 ms) と、検出下限未満の微小な無音 9 個 (約 10 ms) がこれに当たる
- 前の音の終わりが「今 + 余裕 (`AUDIO_PLAYOUT_MIN_LEAD_SECONDS` = 10 ms)」より前のとき。
  補間バッファを今 + 余裕より前に予約できないためである。36 個のうち 9 個
  (合計 86.2 ms、5.8〜22.5 ms) がこれに当たる。アンダーランである

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

Group が異なる Object の順序は保証されない (draft-ietf-moq-transport-22 §2.3.1)。音声は
1 Object = 1 Group なので、datagram でも subgroup でも、受信側が到着順に復号すると
timestamp の順と逆に届いた Object が隙間 0 のまま逆順に鳴り得る。Datagram では加えて
再送されない (RFC 9221)。
2026-10-26 の実リレーの計測では、自然な状態の baseline 3 回 (60 秒、合計 8,921 Object) で
順序逆転は 0 件だった。注入した順序逆転は計器で検出でき、計測方法と結果は
`docs/AUDIO_DATAGRAM_ORDERING.md` にある。

### 3. 停止で切られる音

- 購読側: 停止時は予約済みの音を鳴らし切ってから `AudioContext` を閉じる (drain)。停止の
  要求後は新しい音声 Object を受け付けず、復号前の遅延の段は flush して復号へ流し、
  「最後に鳴り終わる予約 - 現在 + 余裕 100 ms」を 0〜300 ms にクランプした時間だけ待つ。
  flush した音があるときは、予約が無くても上限まで待つ (復号が終われば早く終わる)。
  上限で鳴り切れなかった分だけが `missedByReason.stopped` に残り、鳴らせた量・切った量・
  待ち時間・flush 件数・復号されなかった件数 (`undecodedFlushedObjects`) は `lastDrain` で
  読める (`src/createMediaSubscriber.ts` /
  `src/playout/audioPlayoutSession.ts` / `devtools/src/hooks/useSubscriber.ts`)
- 復号前の遅延: 停止時は `preDecodeDelayStage.stop()` の前に `flush()` を呼び、保持中の
  Object を期限を待たずに復号へ流す。flush した分の復号出力は drain の待ち時間に含める。
  失われるのは flush の後に届いた Object だけであり、停止の要求後は新しい Object を
  受け付けないため通常は 0 件である (`src/createMediaSubscriber.ts` /
  `src/playout/preDecodeDelayStage.ts` / `devtools/src/hooks/subscriberPreDecodeDelay.ts`)
  実リレーの計測 (3 回) では、`missedByReason.stopped` の増分は 0 件、`lastDrain.cutMs` は
  0 ms、drain の待ち時間は 51〜153 ms、停止の完了 (statusMessage が戻るまで) は 94〜209 ms
  だった。`preDecodeDelayMs = 2000` では保持分を 200 件 flush し、225.7 ms 鳴らしたあとに
  1467.8 ms を `stopped` に計上した (上限 300 ms を超える分は切られる)。上限で打ち切った
  とき、復号の出力が届かなかった flush 分は `lastDrain.undecodedFlushedObjects` に件数だけ
  残る (復号していないため長さは分からず、`stopped` には入らない)
- 配信側: 停止時は、周期読み出しのループ自身が取り込みキューを読み切ってから
  1 フレーム先読みの保留分を encode し、`AudioEncoderWrapper.flush()` で encoder に残った
  出力を待って送り切る (この間は世代を進めない)。実装前は単体ハーネスで 10 ms のブロック
  3 つ分 = 30 ms を実測した (未読 1、世代不一致で符号化されない 1、符号化されたが出力が
  close の後で捨てられる 1)。実装後は同じハーネスで送れなかった量が 0 になることを
  固定している。datagram 配送では、書いた末尾の datagram が PUBLISH_DONE より後に届いて
  購読者に捨てられないよう、送信完了の後に 50 ms 待ってから PUBLISH_DONE を送る
  (`AUDIO_TAIL_PUBLISH_DONE_GRACE_MS`)。`pause` は対象外であり、reader を cancel しない
  ため 20 ms の欠落が残る
- Datagram の順序: 停止時に送った末尾の datagram は、PUBLISH_DONE (control stream) より後に
  購読者へ届き得る。購読者は PUBLISH_DONE を受けた時点で購読を closed にするため、後から
  届いた datagram は捨てられる (`src/subscriber.ts` の `SubscriberImpl.handleEnd` と
  `handleDatagram`)。実リレーの publish-done の計測では切られた予約は 0 件で観測されな
  かったが、control stream と datagram の間には順序保証が無く、経路の順序次第で起こり得る。
  送信側では、datagram の write 完了の後に 50 ms 待ってから PUBLISH_DONE を送るようにした
  (猶予の長さの根拠と残るリスクは 8 章を参照)

## 否定した仮説

- 配信側の停止で購読側のセッションが切れ、`AudioContext` が閉じられる: 否定。close-session
  でも購読は connected のままで、TRACK_ENDED だけが届く
- 時間圧縮の継ぎ目がクリックになる: 否定。継ぎ目の段差は自然な差分以下で、実リレーの
  90 件への寄与は 0 件
- 波形を継ぎはぎした位相の飛び: 否定。ゼロ交差間隔の外れは 0 件で、穴の形は「無音が挟まる」
- 予約判断の後に `currentTime` が追い越したことによる重なり: 実機の long-task 記録は 0 件で
  未発生。`createBuffer` の中で時計を 12 ms 進めると再現するため、`start()` の直前に
  `currentTime` を取り直して押し直す実装を入れた。実機の long-task での挙動は未検証である
- 過去時刻の `start()` による重なり: 実リレーでは未発生 (`lateStartCount` 0)。押し直した
  ときは開始時刻を `currentTime + 3 ms` へ移し、先頭 2 ms をフェードインする。押し直した
  回数は `pushStartCount` / `pushStartMaxMs` で読める (追い越しがなくても余裕より近ければ
  押し直すため、`lateStartCount` 0 は押し直しなしを意味しない)
- 冗長化 2 回送りによる同じ音の二重再生: 否定。2 回目は復号へ渡る前に捨てられる
- catch-up の復号器作り直しで、破棄した旧 Worker の出力が交錯する: 否定。dispose の前に
  message handler が外れる
- 44.1 kHz で時間圧縮と補間が効かない: 既知の制限。Opus (48 kHz) の前提では該当せず、
  AAC の 44.1 kHz を使う場合の話である。ノイズではなく、遅れが固定され、欠落が無音になる

## 修正方針と実装状況

優先度の高い順に示す。1〜3 と 5 を実装し、実リレーで検証した。4 の両側フェードは効果と
遅延の取引を計測し、現時点では見送りを推奨する。

1. **計器を足す (実装済み)**
   `AudioPlayoutTimingSnapshot` に、補間で埋まらなかった無音の穴 (`gapCount` / `gapMs` /
   `gapMaxMs`)、予約できる最も早い時刻 (今 + 余裕) より前だった穴
   (`unrecoverableGapCount` / `unrecoverableGapMs`。既に過去の分と、未来でも余裕に
   満たない分を含む)、予約した時刻を `AudioContext.currentTime` が追い越した回数と最大
   (`lateStartCount` / `lateStartMaxMs` / `pushStartCount` / `pushStartMaxMs`)、
   バッファ境界の段差 (`boundaryStepCount` /
   `boundaryStepMax`。しきい値は 440 Hz トーンの正常な差分の約 3 倍の 0.05) を足した。
   `AudioReceiverStats.playoutTiming` と devtools の Audio Playback Timing から読める。
   devtools には、穴・予約不能の穴・予約の追い越しと押し直し・境界の段差を表示する。
   停止の drain は `drainPlayedMs` / `drainCutMs` / `drainWaitedMs` / `drainRequestedMs`、
   受信の到着の遅れは Audio の `receiveDelayMs` / `maxReceiveDelayMs`、目標の上限と圧縮は
   `appliedCeilingMs` / `compressionMsPerSecond` で読める。メインスレッドの停止は
   `stallCount` / `stallMs` / `overlappedArrivals` に出し、直近 10 秒の longtask (50 ms 以上)
   と、到着の間隔が停止区間と重なった到着の数を読める。到着の時刻は受信のコールバックが
   動いた時点で測るため、`receiveDelayMs` には経路と relay の遅れだけでなく、この停止の分も
   混ざる
   段差は「実際に鳴るサンプル」で測るため、2 ms フェードで消えた段差は数えない
2. **予約できる穴を埋める (実装済み)**
   `AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS` を 5 ms から 0.5 ms へ下げ、予約できる隙間は補間で
   埋める。0.5 ms 以下の隙間は前の音の終わりに揃えて穴を作らない (目標の表示時刻が前の
   フレームから 20 µs〜0.5 ms だけ動くことがあり、これを穴として扱うと 1〜2 サンプルの
   デジタル無音が残って段差になるため)。前の音の終わりが今より過去で揃えられないときだけ、
   無音として計器に残して先頭をフェードする。前の音の終わりが今 + 余裕より前でも、今回の開始が今 + 余裕より未来なら、その未来の分
   だけ補間する (`AudioPlayoutScheduler.concealmentOf` の `unrecoverableGapSeconds` と
   `gapStartSeconds`)。補間の末尾は 2 ms で 0 へ落とし、直後の音声の先頭は 2 ms で
   フェードインする (`src/audioSpliceFade.ts` の `fadeSpliceEdge`)。補間の先頭が無音から
   始まる場合 (予約できる最も早い時刻より前の分がある場合) は、補間の先頭もフェードインする。
   穴が無い通常の境界と最初の音にはフェードを入れない (20 ms 周期の振幅変調になり、
   440 Hz で 50 Hz 間隔の側波帯が −26 dBc 立つ)
3. **予約できないアンダーランを減らす (実装済み)**
   アンダーランは事後には埋められないため、穴の累積を目標遅延の閉ループ
   (`src/playout/audioDelayFeedback.ts`) へ入力する。穴が空いたら `reason: "gap"` で目標を
   増やし、穴が続いたら時間圧縮と同じく artifact ceiling (100 → 160 ms) を広げる。戻す
   条件には「穴が 0」も加えた。実測の到着列では深さ 120.5 ms で穴が 0 になる (遅延 +35 ms)。
   さらに、**穴が空いた後は最後の穴から `AUDIO_DELAY_FEEDBACK_GAP_QUIET_MS` (5,000 ms) が
   経つまで目標を下げない** (ホールド)。目標を上げてもすぐ下げると、負荷時に目標が
   100 → 154 → 139 → 120 → 102 → 100 ms と往復し、下げた区間で受信の遅れの裾 (最大
   118 ms) が目標を超えて穴が再発した (実測: gap 3 → 24、unrecoverable 2 → 18、
   concealments 2 → 13)。ホールド中も上げる向き (遅れ / 並べすぎ / 穴) は許す。
   5 秒は制御の間隔 (1 秒) の数回ぶんで、実測の穴の再発間隔 (数秒) より長い
4. **media 時刻の飛びにフェードを入れる (計測の結果、見送りを推奨)**
   1 フレーム先読みして、飛びを検出した境界の前後にフェードを掛ける案を、実リレーの収録と
   再現ハーネスで計測した。実装はしていない。**効果は 1 件 / 61.1 秒** (実装後の収録で
   不連続 10 件のうち media 飛び 1 件。振幅 0.171 = peak の 56 %) であり、**代償は全音声の
   鳴り始め +20 ms** (startDelay 134.1 → 154.1 ms、E2E の長時間テスト 155.5 → 175.5 ms。
   上限 200 ms への余裕は 44.5 → 24.5 ms)、A/V のずれ −3.8 → −23.8 ms (同期の不感帯
   5 ms は超えるが、E2E の skew 予算 150 ms の内側) である。残る不連続 9 件は無音の穴の開始点であり、両側フェード
   では消えない。**現時点では見送り**を推奨する (media 飛びが 1 分に 3 件以上になる、
   E2E の長時間テストの startDelay が上限 200 ms に対して 40 ms 以上の余裕を持つ
   (現状 155.5 ms で余裕 44.5 ms、+20 ms で 24.5 ms のため今は満たさない)、遅延の予算を
   宣言できる、のいずれかで再検討する)。計測の詳細は `investigation-logs/noise-2026-10-20/media-jump-tradeoff.md`。
   なお、損失や復号器の作り直しで `gapSeconds == 0` のまま内容が飛ぶ境界は、今も段差が
   残る (計器の `boundaryStepCount` に出る)
5. **予約の追い越しを直す (実装済み)**
   予約直前に `context.currentTime` を取り直し、`whenSeconds` が
   `currentTime + AUDIO_PLAYOUT_PUSH_START_LEAD_SECONDS` (3 ms。レンダリング量子 128
   フレーム = 約 2.7 ms を踏まえた値) より過去なら、その時刻へ押し直してから
   `source.start()` する。押し直した分は次の音との重なりを生むため、
   `AudioPlayoutScheduler.shiftPlayoutEnd` で「前の音の終わり」を同じ分だけ遅らせ、次の音を
   押し直した後の終わりから並べる。押し直したバッファの先頭は 2 ms フェードインするが、
   前の音の末尾はフェードできないため、押し直しで生じた境界の段差は `boundaryStepCount`
   に数える。押し直した回数と最大は `pushStartCount` / `pushStartMaxMs` で読み
   (`lateStartCount` は追い越した回数だけを数える)、その意味は変えていない
6. **停止時に鳴らし切る (購読側、実装済み)**
   新規の受信と復号を止め、予約済みが鳴り終わるまで待ってから `AudioContext` を閉じる。
   復号前の段は stop ではなく flush して復号へ流す。待ち時間は最後に鳴り終わる時刻から
   現在までに余裕 (100 ms) を足し、0〜300 ms にクランプする。flush した音があるときは、
   予約が無くても上限まで待つ (復号が終われば早く終わる)。`MediaSubscriber.stop` は
   Promise を返すため待ちを追加できる。devtools の停止は同期関数なので、drain の完了を
   待つ非同期の停止と UI 表示が要る。実装は `AudioPlayoutSession.drainReserved` に置き、
   ライブラリと devtools で共有する。`close()` とピア起点の close の上限は 150 ms とする
   (エラー後の後始末が長くブロックしないため)
7. **Audio Config の再構成中も Object を保持する (Opus 前提では対象外)**
   初期 configure 待ちと同じ保留キューへ積み、再構成の完了後に到着順で復号する。config が
   途中で変わるのは AAC を使う場合であり、この調査の前提 (Opus) からは外れる。コード上の
   欠陥として記録だけ残す
8. **配信側の末尾 (Opus + Datagram、実装済み)**
   停止時に周期読み出しのループ自身が取り込みキューを読み切り、1 フレーム先読みを encode
   し、`AudioEncoderWrapper.flush()` で encoder に残った入力を出力させてから送る。
   送るかどうかは世代ではなく「停止の受付時に確定した範囲」で決める (flush が終わるまで
   世代を進めない)。`sendDatagram` は返値の Promise で write の完了を表し、停止時は末尾の
   送信完了を待ってから `AUDIO_TAIL_PUBLISH_DONE_GRACE_MS` = 50 ms の猶予を置き、
   PUBLISH_DONE を送る。購読側の PUBLISH_DONE 後猶予 (datagram の受け付け延長) は
   侵襲的なため実装していない。送れなかった量は `AudioStats.tailDroppedFrames` /
   `tailDroppedMs`、送ろうとした末尾は `tailFlushedFrames` / `tailFlushedMs`（送信を試みた時点で数える） で読める

## 実装後の検証 (2026-10-20、実リレー)

実装後のコードで、同じ調査 spec (`tests/e2e/relay/investigation-audio-output.spec.ts`) を使って
60 秒の連続収録をやり直した。Opus + Datagram、映像あり、冗長度 2 である。

| 指標                              | develop (load 3.0)              | 実装後 (load 10.7)                              |
| --------------------------------- | ------------------------------- | ----------------------------------------------- |
| デジタル無音 (0.5 ms 以上の区間)  | 36 個 / 149.0 ms / 最大 22.5 ms | **8 個 / 39.9 ms / 最大 11.1 ms**               |
| サンプル不連続 (クリック候補)     | 90 件                           | **10 件** (実の穴の開始 9 件 + media 飛び 1 件) |
| 穴の計器 (`gapCount` / `gapMs`)   | 計器なし                        | 21 / 73.3 ms (うち予約不能 9 / 57.5 ms)         |
| 境界の段差 (`boundaryStepCount`)  | 計器なし                        | 10 (波形の不連続 10 件と一致)                   |
| 予約の追い越し (`lateStartCount`) | 計器なし                        | 0                                               |
| 目標遅延 (`appliedMs`)            | 100 ms                          | 160 ms (負荷時の適応上限)                       |
| 鳴り始め p50                      | 115.2 ms                        | 134.1 ms (収録) / 155.5 ms (E2E の長時間テスト) |
| A/V のずれ (`skewMs`)             | −11.7 ms                        | −3.8 ms (不感帯の内側)                          |

- 負荷が違う (develop は load 3.0、実装後は load 10.7) ため、厳密な A/B 比較ではない。
  それでも実装後の方が無音も段差も少ない。同条件の厳密な比較は、本番モジュールを直接
  駆動した再現で行った
- 再現 (実測の到着列、60 秒): 静かな経路・会話風で無音 105 回 / 1032.4 ms・クリック候補 19 件
  → **12 回 / 121.4 ms・3 件**。損失 2 % で無音 151 回 / 2097.5 ms・クリック候補 25 件 →
  **4 回 / 69.7 ms・1 件**。代償は鳴り始めの +5〜9 ms
- 目標遅延が 100 ms に下がった区間で穴が再発していたため、最後の穴から 5 秒間は目標を
  下げないホールドを入れた。ホールドなしは、実リレーで目標が 100 → 154 → 139 → 120 →
  102 → 100 ms と往復し、無音 15 個 / 124.4 ms・不連続 20 件だった。ホールドありで
  無音 8 個 / 39.9 ms・不連続 10 件になる
- 残る段差は、負荷時に目標遅延 160 ms を超える揺らぎ (受信の遅れの最大 113.6 ms と、
  復号や予約の遅れの合算) で起きるアンダーランの開始点 9 件と、media 時刻が飛ぶ境界 1 件で
  ある。前者は遅延をさらに増やすかどうかの取引になり、後者は今回計測して見送りを決めた
  (上記 4)
- 既存の E2E (実リレー) の長時間テストは、補間の上限を 200 ms から 600 ms へ変更し
  (`AUDIO_PLAYOUT_RESULT.md` の既知の限界と同じ理由)、境界の段差 30 件未満と gapMs 300 ms
  未満の判定を加えた。通した回の実測は補間 201 ms、段差 9 件、鳴り始め 155.5 ms、予約の
  追い越し 0 件であり、負荷の高い回は補間 217〜270 ms、段差 10 件だった (同一 run の
  生ログは残していないため、値は負荷で幅がある)
- 停止の drain (別の修正): 購読側 Stop を 3 回測り、いずれも `missedByReason.stopped` の
  増分 0 件 / `lastDrain` の `playedMs` 44〜128 ms / `cutMs` 0 ms / 待ち時間 51〜153 ms
  だった。停止の完了は 94〜209 ms である。`preDecodeDelayMs = 2000` では 200 件 flush し、
  drain の 225.7 ms は鳴らせたが、残り 1467.8 ms は上限 300 ms のため `stopped` に計上した。
  上限で打ち切ったとき、復号の出力が届かなかった flush 分は `lastDrain.undecodedFlushedObjects`
  に件数だけ残る (復号していないため長さは分からず、`stopped` には入らない)
- 配信側の停止の末尾 (別の修正): ライブラリの Publisher (worker 符号化の既定) で、停止時に
  読んだ 4 ブロック (40 ms) がすべて encode・送信され、修正前の 30 ms の欠落が 0 になった
  (単体ハーネス)。実ブラウザ + 実リレーの追加テスト `tests/e2e/relay/audio-publisher-tail.spec.ts`
  では、datagram 配送で停止 102 ms・flush 1 件 20 ms・`tailDroppedFrames` 0・
  `tailFlushTimeoutCount` 0、subgroup 配送で停止 44 ms・flush 1 件 20 ms・`tailDroppedFrames` 0
  だった。購読者は停止の後に末尾を 2 件受信しており、PUBLISH_DONE より先に届いている
- 予約時刻の押し直しと media 飛びの見送り (別の修正): 負荷の低い時間帯 (load average 2 前後)
  の 60.7 秒収録で、デジタル無音 0 件・サンプル不連続 0 件、`gapCount` 1 / 20 ms
  (予約不能 0)、`boundaryStepCount` 1 / 0.108、`lateStartCount` 0、鳴り始め p50 65.3 ms、
  A/V のずれ −9.2 ms だった。media 飛びの両側フェードは 1 フレーム先読みの +20 ms の代償が
  大きいため見送り、段差は `boundaryStepCount` で監視する

## 検証方法

- 単体: 本番モジュールを直接駆動し、穴・境界・media 飛び・停止の各条件を固定する。
  テストのログメッセージは日本語にする
- 実リレー: `tests/e2e/relay/investigation-audio-output.spec.ts` で購読音声を波形として収録し、
  デジタル無音と境界の段差を測る。`MOQT_INVESTIGATION=1` のときだけ動く調査専用の spec で
  あり、通常の CI では動かさない
- E2E の判定: 計器の `boundaryStepCount` / `gapMs` を実リレーの標準スイートへ足し、
  穴と段差の量を判定する (長時間テストに追加済み)
- devtools: 統計に穴の回数・ms、予約の追い越しと押し直し、境界の段差、停止の drain、
  到着の遅れ、目標の上限と圧縮、メインスレッドの停止を表示する (追加済み)

## 残る不明点

- 実機のスピーカーで「プチプチ」と聞こえるかの確認はしていない。波形の段差からの推定である
- 購読 Stop の drain は、目標遅延 100〜160 ms の条件で `stopped` 0 件を確認した。目標遅延
  50 ms の静かな経路では未計測である。`preDecodeDelayMs > 0` では上限 300 ms を超える保持分が
  切られるため、遅延を大きく設定したときの停止の聞こえ方は聴感で確認していない
- Datagram の損失があるときの穴の量を測っていない。今回の収録は損失 0 相当であり、
  Opus の PLC を使えない状態で 20 ms のフレームが落ちたときに、補間で埋まる割合と、
  冗長度 2 で救える割合は未計測である
- PUBLISH_DONE と末尾の datagram の到着順が入れ替わる頻度は測っていない
- Dedicated Worker で符号化しているときの、停止時の encoder 入力と出力の差は測れていない
- 音声の到着順が timestamp 順と逆になる頻度は確認していない
- 15 分以上の単一セッションでの再現性は、この調査の条件 (最大 60.7 秒) では確認していない
- 実音声 (Opus で復号した声) での時間圧縮と補間の粗さの寄与は、合成信号の計測に留まる
- 予約の追い越し (`lateStartCount`) は実リレーの収録と E2E で 0 だった。押し直し
  (予約時刻のクランプ) は実装済みで、実機の long-task が起きたときの重なりは未検証である。
  押し直しの回数は `pushStartCount` / `pushStartMaxMs` で読む (追い越しが無くても余裕より
  近ければ押し直すため、`lateStartCount` 0 は押し直しなしを意味しない)
- 実装後の実リレーの計測は load average 10.7 の時間帯のものと、load average 2 前後の
  低負荷のものがある。適応の上限 (160 ms) に張り付いた状態での A/V 同期と遅延の許容は、
  負荷の低い条件で再確認する必要がある
