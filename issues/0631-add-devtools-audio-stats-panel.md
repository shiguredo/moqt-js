# devtools の DebugPanel に音声の統計を表示する

- Created: 2026-09-20
- Completed: 2026-09-28
- Branch: feature/add-devtools-audio-stats-panel
- Polished: {YYYY-MM-DD}

## 目的

音声の受信数・デコード数・最終 Audio Level は signal に保持しているが、`window.moqtDevTools` からしか読めない。画面を見ながら相互運用を実測するとき、音声 object が届いているか、publisher が draft-ietf-moq-loc-04 §2.3.3.2 の Audio Level を載せているかを人間が確認する導線が無い。

DebugPanel に音声の統計を表示し、Playwright 以外の手段でも音声経路の状態を確認できるようにする。

## 現状

- `devtools/src/components/DebugPanel.tsx` は publisher の `framesEncoded` / `objectsSent` / `bytesSent` と subscriber の統計を表示するが、音声の項目は無い
- `devtools/src/signals/publisher.ts` の音声の signal (`pubCurrentAudioGroup` / `pubAudioGroupStarted` / `lastSentAudioConfig`) と `devtools/src/signals/subscriber.ts` の音声の signal (`audioObjectsReceived` / `audioChunksDecoded` / `audioLastLevel` / `audioPlaybackEnabled`) は UI から読まれていない
- `window.moqtDevTools` の `SubscriberStats` には `audioObjectsReceived` / `audioChunksDecoded` があるが、Audio Level は公開していない (受信音声の可視化側で扱う)

## 設計方針

- DebugPanel に音声の統計セクションを足し、subscriber ごとに `audioObjectsReceived` / `audioChunksDecoded` / Audio Level / 再生の有無を表示する
- Audio Level は RFC 6464 §3 の -dBov として表示し (0 が最大、127 がデジタル無音)、voiceActivity も併記する。未報告 (Audio Level が載っていない object を受けた状態) は「未報告」と出す
- publisher 側は音声の Group ID と、Audio Config を保持しているかどうかを表示する
- 表示は `data-testid` を付け、E2E から読めるようにする

## 完了条件

- DebugPanel に音声の統計が表示される (音声が無効なときも表示が壊れない)
- Audio Level が -dBov として、voiceActivity と併せて表示される
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.3.2 (Audio Level: RFC 6464 §3 の -dBov と voice activity を vi64 の最下位 8 bit に符号化する)
- RFC 6464 §3 (level は -dBov で 0〜127 が 0〜-127 dBov。デジタル無音は 127)
- draft-ietf-moq-msf-01 §5.2.6 (Track role)

## 解決方法

本 issue の目的 (音声 object の到達と publisher が Audio Level を載せているかを人間が確認できる導線) は、対応 issue の 0626 `devtools にダミー音声の配信と購読を追加する`・0627 `devtools で受信した音声を可視化する`・0736 `moqt-devtools の publisher に音声のレベルメーターが無く、取っている音と送っている音の大きさが分からない` の実装で達成されている。本 issue の「現状」は現行実装と食い違う (陳腐化) ため、ソースとの照合で検証した結果、対応不要と判断して closed にする。

### 実装済みの確認 (ソース照合)

- subscriber の音声統計は `devtools/src/components/SubscriberPanel.tsx` の Statistics の「Audio」セクションに表示済みである (`audioObjectsReceived` / `audioChunksDecoded` / `audioDatagramObjectsReceived` / `audioCatchUpObjectsSkipped`)
- Audio Level は `devtools/src/components/AudioMeter.tsx` が -dBov で表示し、voice activity を併記する。未報告は `devtools/src/utils/audioLevel.ts` の `formatAudioLevel` が `not reported` と出す (subscriber 側 `audio-level` / `audio-voice-activity`、publisher 側 `publisher-audio-level` / `publisher-audio-voice-activity` の data-testid 付き)
- publisher 側も `devtools/src/components/PublisherPanel.tsx` に同じ AudioMeter があり、送った object の LOC Audio Level と voice activity を表示する (0736)
- 再生の有無は SubscriberPanel の「Play Audio」トグルで確認でき、`window.moqtDevTools` の `SubscriberStats.audio.playbackEnabled` (devtools/src/signals/statsSnapshot.ts) にもある
- `window.moqtDevTools` の `SubscriberStats.audio` は `lastLevel` / `lastVoiceActivity` も公開している。本 issue の「Audio Level は公開していない」は現行と食い違う

### 前提の誤り

- 統計は `devtools/src/components/DebugPanel.tsx` ではなく、`PublisherPanel` / `SubscriberPanel` の Statistics 欄 (`StatsCollapse`) が表示する。`DebugPanel.tsx` はログ一覧のみである (0764)。「DebugPanel に音声の統計セクションを足す」は現行の構成では成立しない

### 残っていた要求と判断

- publisher の音声 Group ID (`pubCurrentAudioGroup` / `pubAudioGroupStarted`) と Audio Config の保持 (`lastSentAudioConfig`) の表示は未実装である。ただし、これは発信側の内部状態の表示であり、本 issue の動機 (音声経路と Audio Level の有無の確認) を支えないため、対応不要と判断する

### 参照の検証

- draft-ietf-moq-loc-04 §2.3.3.2 (Audio Level は RFC 6464 §3 の level と voice activity を vi64 の最下位 8 bit に符号化する) と RFC 6464 §3 (0〜127 が 0〜-127 dBov、デジタル無音は 127) の記述は一次資料と一致する
