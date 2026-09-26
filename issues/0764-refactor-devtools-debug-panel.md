# moqt-devtools の DebugPanel を現在の実装に合わせて整備する

- Created: 2026-09-26
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-devtools-debug-panel
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の DebugPanel (`devtools/src/components/DebugPanel.tsx`) は早い時期に作られ、その後 moqt-js / moqt-devtools に足された設定・統計へ追従できていない。とくに「Copy for LLM」でコピーするテキストは signal を手書きで列挙しているため、接続設定・publisher 統計・subscriber 統計の多くの項目が抜け落ちている。不具合の報告に使うテキストなので、抜けがあると原因の切り分けができない。

また、ログの蓄積がコンポーネントファイルに置かれ、hooks と `App` が components を import する依存の向きになっており、直近で `devtools/src/webtransport-devtools/messageLog.ts` に切り出したログの作法 (追加時に 1 回だけ整形して保持する) とも揃っていない。

## 現状

- `devtools/src/components/DebugPanel.tsx` は 738 行 1 コンポーネント。ログの蓄積 (`addLog` / `logBuffer` / `logCount` / `logSequence` / `autoScroll` / `__resetLogStateForTest`) がこのファイルにあり、`devtools/src/hooks/usePublisher.ts` / `devtools/src/hooks/useSubscriber.ts` / `devtools/src/hooks/debugMessageLog.ts` / `devtools/src/hooks/publisherAudioMeter.ts` と `devtools/src/App.tsx` が `components/DebugPanel` から import している
- `devtools/src/webtransport-devtools/messageLog.ts` の `appendMessage` は日時を追加時に 1 回だけ整形して `StreamMessage.formattedTimestamp` に持つ。DebugPanel の `LogEntry` は `timestamp` だけを持ち、描画のたびに `formatAbsoluteTime` / `formatElapsedTime` / `formatDeltaTime` を全行について呼び直す
- 「Copy for LLM」のテキストを作る `generateSettingsText` / `generatePublisherStatsText` / `generateSubscriberStatsText` は signal を手書きで列挙している。現在の実装に対して次の項目が出ない
  - 接続設定: `targetLatency` / `renderGroup` / `catalogSubscriptionTimeout` / `videoSource` / `selectedCameraDeviceId` / `resolution` 以外の映像の設定は出るが、音声の設定 (`audioSource` / `audioDelivery` / `audioCodec` / `audioBitrate` / `audioSampleRate` / `audioChannels` / `selectedMicrophoneDeviceId` / `selectedAudioOutputDeviceId` / `audioEchoCancellation` / `audioNoiseSuppression` / `audioAutoGainControl`) と認可トークンの設定、`mode` が出ない
  - Subscriber: `currentSubGroup` と、音声の統計 (`audioObjectsReceived` / `audioChunksDecoded` / `audioPeakDbfs` / `audioRmsDbfs` / `audioLastLevel` / `audioPlayoutRebases` / `audioPlayoutDrops`)、音声と映像の同期 (`avSync`) が出ない
  - Publisher: テスト用 API の `PublisherStats` にある `newGroupRequests` は出るが、`codec` / `chunksEncoded` / `encodeErrors` / `forwardState` / `httpVersion` は出ない。逆にテスト用 API 側には `pubCodec` などが無い
- `devtools/src/testApi.ts` の `buildSubscriberStats` は `window.moqtDevTools` へ出す統計の唯一の変換だが、画面の表示とコピー本文はこれを使わず独自に signal を読んでいる。同じ統計に 3 つの実装 (画面 / テスト用 API / コピー本文) がある
- コピー本文を検証するテストが無い (`devtools/src/components/DebugPanel.test.ts` はログの蓄積だけを見る。E2E はパネルを開いて文言が英語であることだけを見る)

## 設計方針

- ログの蓄積を `devtools/src/signals/debugLog.ts` へ移す。`autoScroll` はパネルの表示状態なので `devtools/src/signals/debug.ts` へ移す。hooks と `App` は signals を import するようになり、components への依存が無くなる
- `LogEntry` に表示用の整形済みの値を追加し、追記時に 1 回だけ作る (`messageLog.ts` の `StreamMessage.formattedTimestamp` と同じ作法)。経過時間の基準は「ログを消してから最初の 1 件」に固定する (上限到達で古いログを捨てても基準が動かないため、行の表示を作り直さずに済む)
- Copy for LLM のテキストを `devtools/src/utils/debugExport.ts` へ移す。統計の節は `devtools/src/testApi.ts` のスナップショットから生成し、フィールドを足せばコピー本文にも自動で出る形にする
- 統計のスナップショット (`PublisherStats` / `SubscriberStats` / `buildPublisherStats` / `buildSubscriberStats`) を `devtools/src/signals/statsSnapshot.ts` へ移し、テスト用 API とコピー本文で 1 つの実装を共有する。現在コピー本文にしか無い情報 (session の `getStatistics()`、catalog、`codec` など) はスナップショット側へ足す
- 接続設定のスナップショットを 1 つ作り、設定の節はそこから生成する。テストで signal の網羅を固定し、除外する signal は理由を書く
- 認可トークンの値 (`authorizationTokenValue` / `authorizationTokenBase64`) はコピー本文に載せない。載せたかどうかと種別だけを載せる
- 行の表示は `DebugLogRow` に切り出す。見た目と操作 (展開、折りたたみ、行コピー、一括コピー、オートスクロール、Esc) は変えない

## 完了条件

- hooks と `App` が `components/DebugPanel` を import しない
- Copy for LLM のテキストに、接続設定・publisher・subscriber のスナップショットにあるすべてのフィールドが出る (テストで固定する)
- 認可トークンの値はスナップショットに入れず、送るかどうかと種別だけを出す (テストで固定する)。c4m を含む Relay URI と payload の hex dump から値を消すのは別 issue で行う
- 画面の表示 (行の日時・経過・差分、展開、コピー) が変わらない
- `vp check` / `vp exec tsc --noEmit` / `vp exec tsc -p devtools --noEmit` / `vp test run` / `vp run e2e-test` が通る

## 参照

- `devtools/src/components/DebugPanel.tsx` の `addLog` / `generateSettingsText` / `generatePublisherStatsText` / `generateSubscriberStatsText` / `generateFullLogText`
- `devtools/src/webtransport-devtools/messageLog.ts` の `appendMessage` / `formatTimestamp`
- `devtools/src/testApi.ts` の `PublisherStats` / `SubscriberStats` / `buildSubscriberStats` / `initTestApi`
- `devtools/src/signals/connectionSettings.ts` の signal と `buildQueryParams`
- `devtools/src/utils/logFormatters.ts` の `formatAbsoluteTime` / `formatElapsedTime` / `formatDeltaTime`
