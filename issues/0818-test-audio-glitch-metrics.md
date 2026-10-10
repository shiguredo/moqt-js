# 音声の途切れを数値で評価する仕組みを用意する (Stream と Datagram の両方)

- Created: 2026-10-06
- Completed: {YYYY-MM-DD}
- Branch: feature/test-audio-glitch-metrics
- Polished: 2026-10-10

## 目的

音声がプツプツ途切れることがあり、その原因 (経路の損失、jitter buffer の不足、時間伸縮の失敗) を実測の数値で切り分けたい。「途切れの少なさ」を数値で確認する仕組みを用意する。音声 Object の配送経路は Subgroup (stream) と Datagram の両方があり (draft-ietf-moq-transport-22 §11)、再送の有無が途切れに与える影響が異なるため、両方の経路で同じ指標を取り、経路の違いで比較できるようにする。

## 現状

- 受信側の統計 `AudioReceiverStats` (`src/codec/types.ts`) は `playoutRebases` / `playoutDrops` / `playoutConcealments` / `playoutCompressedMs` / `playoutConcealedMs` / `playoutLatenessMs` に加えて、再生の観測値 `playoutTiming` (`AudioPlayoutTimingSnapshot`、`src/audioPlayoutTimingStats.ts`) を持つ (`MediaSubscriberImpl.audioReceiverStats`、`src/createMediaSubscriber.ts`)。`playoutTiming` には鳴らすと決めた音の総数・総時間 (`playedFrames` / `playedMs`) と、鳴らさなかった音の数・長さ (`missedFrames` / `missedMs`、理由別の内訳 `missedByReason`) があり、補間 (`playoutConcealedMs`) と捨て (`playoutDrops`、長さは `missedByReason.backlog.ms`) の割合は `playedMs` を分母に計算できる。残るのは経路別の受信数であり、ライブラリには無い (devtools は `audio.datagramObjectsReceived` を持つ)
- 受信経路の区別はライブラリでは取っていない。`MediaSubscriberImpl` は `session.subscribe` に `object` callback だけを登録し、Datagram で届いた Object は `object` callback へフォールバックする (`src/session/incoming.ts` の `incomingHandleDatagram` は datagram callback があれば `handleDatagram`、なければ `handleObject` に流す)。両方の経路が 1 つの callback にまとまるため、経路別の受信数が測れない
- devtools は `datagram` callback を登録して `audioDatagramObjectsReceived` を数える (`devtools/src/hooks/useSubscriber.ts` の `handleAudioObject` / `devtools/src/signals/subscriber.ts`。`audioObjectsReceived` との差が Subgroup で届いた数)。配線の先例はあるがライブラリ側には無い
- 送信側の高レベル API (`createMediaPublisher` / `AudioPublishOptions`) には音声の送り方を選ぶ設定が無い。`sendObject` のみを使う (`src/createMediaPublisher.ts` の `sendAudioFrameFireAndForget`)。devtools 独自に `shouldSendAudioAsDatagram` (`devtools/src/utils/audioDelivery.ts`) と `audioDelivery` の設定 (`devtools/src/signals/connectionSettings.ts`。URL パラメータ `audioDelivery=datagram` で指定) と `sendDatagram` (`devtools/src/hooks/usePublisher.ts`) で選んでいる
- 実リレーの音声の往復テストは、devtools のページ (port 5173) と偽マイク (`--use-fake-device-for-media-stream`。`TEST_MOQT_URI` 未設定では skip) を使う `tests/e2e/relay/audio-timestamp.spec.ts` / `audio-catch-up.spec.ts` にある。ただしこれらは devtools の配線を検証するもので、ライブラリ (`tests/e2e/main.ts` + `createMediaPublisher` / `createMediaSubscriber`) の音声の往復テストは無い。`tests/e2e/devtools-audio-meter.spec.ts` 5 行目の「音声 object の到達は相互運用 harness 側で検証する」は上記の relay テストが担っており、メーター画面のテストには実リレーの検証が含まれない
- `tests/e2e/main.ts` は Canvas の映像だけを publish し、音声ソースを持たない。トーン音源 (`devtools/src/webcodecs-devtools/utils/dummyAudio.ts` の `createToneSamples`) は実リレーの音声テストでは使っておらず (偽マイクで代替)、`tests/e2e/main.ts` からも使えない。音声ソースには偽マイクの先例 (上記の relay テスト) をそのまま使える

## 設計方針

1. 受信側の統計 (`src/codec/types.ts` と `src/createMediaSubscriber.ts`)
   - `AudioReceiverStats` に経路別の受信数 (`subgroupFramesReceived` / `datagramFramesReceived` など。名前は実装時に `framesReceived` との整合で決める) を追加する。再生した総時間は既に `playoutTiming.playedMs` にあり、補間率・捨て率の分母分子 (補間は `playoutConcealedMs`、捨ては `playoutDrops` / `missedByReason.backlog`) も揃っているため、累積を新たに足さない。補間を分母に含めるか (分母を `playedMs` にするか、補間も足すか) は補間率の定義と合わせて実装時に決め、理由をコメントに書く
   - 途切れの指標 (補間率・捨て率) は、既存の `playoutConcealedMs` / `playoutTiming` と追加した経路別の受信数から読む側が計算する。ライブラリは割合を出さず、実測の内訳だけを返す
   - `MediaSubscriberImpl` は `datagram` callback を devtools と同じく登録し、Subgroup と同じ処理へ流す (処理本体は 1 つにし、経路だけ数える)。devtools の `handleAudioObject` が「Datagram でも復号の順序は到着順で足りる」としている方針に合わせる
2. 送信側の delivery 選択 (`src/createMediaPublisher.ts` と `src/codec/types.ts`)
   - `AudioPublishOptions` に音声の送り方 (`"subgroup" | "datagram"`) を追加する。既定は `subgroup` (現行挙動)。公開型のため `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions.audio` の記述にも追記する
   - `datagram` 指定時は `Publisher.sendDatagram` (`src/publisher.ts`) を使う
   - reliable-only (WT-H2) では Datagram を使えない。devtools の `shouldSendAudioAsDatagram` は「reliable-only では Subgroup に戻す」規則であるが、高レベル API が宣言された設定を裏で変えるのは不整合であるため、指定されたらエラーにして呼び出し側へ明示する方針とする (実装時にコメントで理由を書く)
3. 実リレーを使う E2E (`tests/e2e/` と `tests/e2e/main.ts` と `tests/e2e/relay/`)
   - `tests/e2e/main.ts` に音声の publish / subscribe 操作を追加する (`window.__moqtE2E` の `startPublisher` / `startSubscriber` に音声オプション)。音声ソースは偽マイク (`--use-fake-device-for-media-stream`。`audio-timestamp.spec.ts` の先例) とし、トーン音源は用意しない
   - 同じ namespace で (1) Subgroup で音声を配信する往復、(2) Datagram で配信する往復を 1 spec 内で行う (`tests/e2e/relay/` に 1 spec 追加)。本 issue の担当は「音声経路の統計比較」であり、open の 0817 (実リレーへの Object Datagram 配送 §11.2 の検証。`tests/e2e/main.ts` の低レベル) と同じ経路の検証は重ねない。0817 と `tests/e2e/main.ts` の改造が重なった場合は、片方が先に通したものを再利用する
   - `getStats()` の戻り値から、Subgroup の往復では経路別の受信数が送信数に一致すること (subgroup は信頼性のある stream で届くため)、Datagram の往復では受信数 / 送信数から求めた欠落率と、補間と捨ての割合 (分母は `playoutTiming.playedMs`) がしきい値未満であることを assert する。しきい値は「プツプツが明らかに起きている状態」との見比べで実測して決める (Datagram は再送されず、draft-ietf-moq-transport-22 §11.2 はサイズ超過時の暗黙的なドロップを許すため、リモートの実リレーに対して Datagram の受信数 = 送信数を要求しない。`src/session/publicTypes.ts` の `SubscribeCallbacks.datagram` の注記も同じ趣旨である)
   - トーンに対する PCM 分析 (クリック検出) はこの issue では行わない。論理的途切れ (補間・捨て・欠落) の統計で評価する範囲に留める

## 完了条件

- 実リレーを使う E2E で、Subgroup と Datagram の両方の音声購読が通ること
- `getStats()` が経路別の受信数を返すこと (再生した総時間は既に `AudioReceiverStats.playoutTiming.playedMs` が返している。型の増減は `src/index.ts` の export と docs の追従も含める)
- 実リレーで音声を配信した状態での補間率・捨て率が、実測に基づくしきい値未満であることを E2E が確認すること (Datagram の往復では欠落率も同じく実測に基づくしきい値未満)
- reliable-only のセッションで `datagram` 指定の音声 publish がエラーになることが単体テストで固定されること
- `vp check` / `vp test run` が通り、実リレーが使える環境で `vp run e2e-test:relay` が通ること

## 参照

- devtools の先行実装: `devtools/src/hooks/useSubscriber.ts` (datagram callback の登録と経路別の数) / `devtools/src/signals/subscriber.ts` (`audioDatagramObjectsReceived` と、`audioObjectsReceived` との差が Subgroup 経路の数) / `devtools/src/utils/audioDelivery.ts` (`shouldSendAudioAsDatagram`) / `devtools/src/hooks/usePublisher.ts` (`sendDatagram` と `audioDelivery` の選択) / `devtools/src/signals/connectionSettings.ts` (`audioDelivery` の URL パラメータ)
- `src/session/incoming.ts` (Datagram から `object` callback へのフォールバック) / `src/session/publicTypes.ts` (`SubscribeCallbacks` の `datagram` callback) / `src/publisher.ts` (`sendDatagram`) / `src/audioPlayout.ts` (`AudioPlayoutScheduler`) / `src/audioPlayoutTimingStats.ts` (再生した総時間 `playedMs` と鳴らさなかった量)
- 実リレーの音声 E2E の先例: `tests/e2e/relay/audio-timestamp.spec.ts` / `tests/e2e/relay/audio-catch-up.spec.ts` (devtools のページと偽マイク。ライブラリの配線ではない)
- 0817 (open。実リレーを使った E2E を増やし、Object Datagram 配送 §11.2 も検証対象。tests/e2e/relay/ の主改造元) / 0784 (closed。実リレーへ接続する E2E テストを追加) / 0754 (closed。実リレーの音声 E2E と TIMESTAMP のずれ) / 0793 (devtools 側の補間のテスト。ライブラリ側とは別に管理) / 0794 (補間の末尾フェード。プツプツの主因候補の 1 つ)
- refs/moq/draft-ietf-moq-transport-22.txt §11 (Data Streams and Datagrams) / §11.2 (Datagrams。サイズ超過時は明示なしで drop)
