# 音声の途切れを数値で評価する仕組みを用意する (Stream と Datagram の両方)

- Created: 2026-10-06
- Completed: {YYYY-MM-DD}
- Branch: feature/test-audio-glitch-metrics
- Polished: 2026-10-06

## 目的

音声がプツプツ途切れることがあり、その原因 (経路の損失、jitter buffer の不足、時間伸縮の失敗) を実測の数値で切り分けたい。「途切れの少なさ」を数値で確認する仕組みを用意する。音声 Object の配送経路は Subgroup (stream) と Datagram の両方があり (draft-ietf-moq-transport-22 §11)、再送の有無が途切れに与える影響が異なるため、両方の経路で同じ指標を取り、経路の違いで比較できるようにする。

## 現状

- 受信側の統計 `AudioReceiverStats` (`src/codec/types.ts`) は `playoutRebases` / `playoutDrops` / `playoutConcealments` / `playoutCompressedMs` / `playoutConcealedMs` / `playoutLatenessMs` を持つ (`MediaSubscriberImpl.audioReceiverStats`、`src/createMediaSubscriber.ts`)。ただし再生した総時間が無いため、途切れの割合 (補間と捨てが再生全体の何%) に換算できない
- 受信経路の区別はライブラリでは取っていない。`MediaSubscriberImpl` は `session.subscribe` に `object` callback だけを登録し、Datagram で届いた Object は `object` callback へフォールバックする (`src/session/incoming.ts` の `incomingHandleDatagram` は datagram callback があれば `handleDatagram`、なければ `handleObject` に流す)。両方の経路が 1 つの callback にまとまるため、経路別の受信数が測れない
- devtools は `datagram` callback を登録して `audioDatagramObjectsReceived` を数える (`devtools/src/hooks/useSubscriber.ts` の `handleAudioObject` / `devtools/src/signals/subscriber.ts`)。配線の先例はあるがライブラリ側には無い
- 送信側の高レベル API (`createMediaPublisher` / `AudioPublishOptions`) には音声の送り方を選ぶ設定が無い。`sendObject` のみを使う (`src/createMediaPublisher.ts` の `sendFrameFireAndForget`)。devtools 独自に `shouldSendAudioAsDatagram` (`devtools/src/utils/audioDelivery.ts`) と `sendDatagram` (`devtools/src/hooks/usePublisher.ts`) で選んでいる
- E2E は `tests/e2e/relay/` (実リレー接続。`TEST_MOQT_URI` 未設定では skip) に映像だけがあり、音声を含む実リレーの往復テストは無い。`tests/e2e/devtools-audio-meter.spec.ts` は「実音声 object の到達は相互運用 harness 側で検証する」とコメントするが実体が無い
- トーン音源 (`devtools/src/webcodecs-devtools/utils/dummyAudio.ts` の `createToneSamples`) は devtools パッケージ内にあり、実リレー接続のテストページ (`tests/e2e/main.ts`) からは使えない。`tests/e2e/main.ts` は Canvas の映像だけを publish する

## 設計方針

1. 受信側の統計 (`src/codec/types.ts` と `src/createMediaSubscriber.ts` と `src/audioPlayout.ts`)
   - `AudioReceiverStats` に経路別の受信数 (`subgroupFramesReceived` / `datagramFramesReceived` など。名前は実装時に `framesReceived` との整合で決める) と、再生した総時間 (`playoutPlayedMs` など) を追加する
   - 再生した総時間は、`AudioPlayoutScheduler` (`src/audioPlayout.ts`) が再生 (`play`) と決めた音の長さを積み上げた値とし、捨てた音 (`drop`) は含めない。現行の再生の統計 (rebases / drops / compressed / concealed / lateness) は `MediaSubscriberImpl.audioReceiverStats` が `AudioPlayoutScheduler` から読んでいるため、総時間の累積も同じ場所に置く。補間した分を分母に含めるかは補間率の定義と合わせて実装時に決め、理由をコメントに書く
   - 途切れの指標 (補間率・捨て率) は、既存の `playoutConcealedMs` / `playoutDrops` と追加した再生総時間から読む側が計算する。ライブラリは割合を出さず、実測の内訳だけを返す
   - `MediaSubscriberImpl` は `datagram` callback を devtools と同じく登録し、Subgroup と同じ処理へ流す (処理本体は 1 つにし、経路だけ数える)。devtools の `handleAudioObject` が「Datagram でも復号の順序は到着順で足りる」としている方針に合わせる
2. 送信側の delivery 選択 (`src/createMediaPublisher.ts` と `src/codec/types.ts`)
   - `AudioPublishOptions` に音声の送り方 (`"subgroup" | "datagram"`) を追加する。既定は `subgroup` (現行挙動)。公開型のため `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions.audio` の記述にも追記する
   - `datagram` 指定時は `Publisher.sendDatagram` (`src/publisher.ts`) を使う
   - reliable-only (WT-H2) では Datagram を使えない。devtools の `shouldSendAudioAsDatagram` は「reliable-only では Subgroup に戻す」規則であるが、高レベル API が宣言された設定を裏で変えるのは不整合であるため、指定されたらエラーにして呼び出し側へ明示する方針とする (実装時にコメントで理由を書く)
3. 実リレーを使う E2E (`tests/e2e/` と `tests/e2e/main.ts`)
   - テストページに音声の publish / subscribe 操作を追加する。トーン音源は `tests/e2e/` 側に用意する (devtools パッケージの `dummyAudio.ts` をテストページから参照するか、同程度の生成関数を tests/e2e に置くかを実装時に決め、重複を選んだ理由をコメントに書く)
   - 同じ namespace で (1) Subgroup で音声を配信する往復、(2) Datagram で配信する往復を 1 spec 内で行う (`tests/e2e/relay/` に 1 spec 追加)。本 issue の担当は「音声経路の統計比較」であり、open の 0817 (実リレーへの Object Datagram 配送 §11.2 の検証) と同じ経路の検証は重ねない。0817 とテストページ (tests/e2e/main.ts) の改造が重なった場合は、片方が先に通したものを再利用する
   - `getStats()` の戻り値から、Subgroup の往復では経路別の受信数が送信数に一致すること (subgroup は信頼性のある stream で届くため)、Datagram の往復では受信数 / 送信数から求めた欠落率と、補間と捨ての割合がしきい値未満であることを assert する。しきい値は「プツプツが明らかに起きている状態」との見比べで実測して決める (Datagram は再送されず、draft-ietf-moq-transport-22 §11.2 はサイズ超過時の暗黙的なドロップを許すため、リモートの実リレーに対して Datagram の受信数 = 送信数を要求しない。`src/session/publicTypes.ts` の `SubscribeCallbacks.datagram` の注記も同じ趣旨である)
   - トーンに対する PCM 分析 (クリック検出) はこの issue では行わない。論理的途切れ (補間・捨て・欠落) の統計で評価する範囲に留める

## 完了条件

- 実リレーを使う E2E で、Subgroup と Datagram の両方の音声購読が通ること
- `getStats()` が経路別の受信数と再生した総時間を返すこと (型の増減は `src/index.ts` の export と docs の追従も含める)
- 実リレーで音声を配信した状態での補間率・捨て率が、実測に基づくしきい値未満であることを E2E が確認すること (Datagram の往復では欠落率も同じく実測に基づくしきい値未満)
- reliable-only のセッションで `datagram` 指定の音声 publish がエラーになることが単体テストで固定されること
- `vp check` / `vp test run` が通り、実リレーが使える環境で `vp run e2e-test:relay` が通ること

## 参照

- devtools の先行実装: `devtools/src/hooks/useSubscriber.ts` (datagram callback の登録と経路別の数) / `devtools/src/utils/audioDelivery.ts` (`shouldSendAudioAsDatagram`) / `devtools/src/webcodecs-devtools/utils/dummyAudio.ts` (トーン音源)
- `src/session/incoming.ts` (Datagram から `object` callback へのフォールバック) / `src/session/publicTypes.ts` (`SubscribeCallbacks` の `datagram` callback) / `src/publisher.ts` (`sendDatagram`) / `src/audioPlayout.ts` (`AudioPlayoutScheduler`。再生の統計と再生総時間の累積)
- 0817 (open。実リレーを使った E2E を増やし、Object Datagram 配送 §11.2 も検証対象。tests/e2e/relay/ の主改造元) / 0703 (実リレーを起動する相互運用 harness の先例を作る方向。tests/e2e/relay/ の構成) / 0793 (devtools 側の補間のテスト。ライブラリ側とは別に管理) / 0794 (補間の末尾フェード。プツプツの主因候補の 1 つ)
- refs/moq/draft-ietf-moq-transport-22.txt §11 (Data Streams and Datagrams)
