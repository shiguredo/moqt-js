# devtools の DebugPanel に音声の統計を表示する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
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

{未着手}
