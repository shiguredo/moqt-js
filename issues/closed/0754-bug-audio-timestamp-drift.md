# 送る音声の TIMESTAMP が壁時計から遅れていき、受信側で基準の取り直しが続く

- Created: 2026-09-25
- Completed: 2026-10-09
- Branch: feature/fix-audio-timestamp-drift
- Polished: 2026-09-27
- Reporter: @voluntas

## 目的

moqt-devtools で長く配信すると、受信側で音声の「鳴らす時刻 - TIMESTAMP」が伸び続けた。音声は 1 秒に約 50 個のまま実時間どおりに届いていたため、送る側が付ける音声の TIMESTAMP が壁時計から少しずつ遅れていったとみている。LOC の TIMESTAMP (draft-ietf-moq-loc-04 Section 2.3.1.1) は壁時計の取得時刻であり、ずれると受信側の再生の基準 (`src/audioPlayout.ts`) が合わなくなって取り直しが続き、映像との時刻の対応も崩れる。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `handleAudioEncodedChunk` と `src/createMediaPublisher.ts` は、LOC の TIMESTAMP を `LOC.toUnixEpochMicroseconds(BigInt(chunk.timestamp), performance.timeOrigin)` で求める。`chunk.timestamp` (AudioEncoder の出力、元は MediaStreamTrackProcessor の `AudioData.timestamp`) が `performance.now()` と同じ時計のマイクロ秒であることを前提にしている
- 実測 (2026-09-25、配備の relay、moqt-devtools、headless Chromium の偽のマイク): 受信側で測った「鳴らす時刻の壁時計 - TIMESTAMP」は、10 秒で 217 ms、200 秒で 4802 ms、336 秒で 16027 ms と伸び続けた。この間、鳴らす時刻までの余裕は 300 ms 以下で、復号した音声は 1 秒に約 50 個だった。映像の遅れ (TIMESTAMP から表示まで) は約 32 ms のままだった
- 本物のマイクで同じことが起きるかは確かめていない

## 設計方針

- まず原因を確かめる。送る側で `performance.now() * 1000 - AudioData.timestamp` の推移を、偽のマイクと本物のマイクで 10 分以上記録する
  - 伸び続けるなら、`AudioData.timestamp` は `performance.now()` の時計ではない (サンプル数から数えている、取りこぼしを数えないなど)。TIMESTAMP の求め方を見直す
  - 伸びないなら、送る側の音声の処理が実時間に追いついておらず、溜まった音を後から送っている。どこで溜まるかを調べる
- 見直すときも、LOC の TIMESTAMP は取得した時刻の壁時計 (Unix epoch マイクロ秒) のままにする

## 完了条件

- 原因を特定し、同じ条件で 10 分以上流して、受信側の「鳴らす時刻 - TIMESTAMP」が伸び続けない
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る

## 計測結果

配信側で「読み出した壁時計 - `AudioData.timestamp`」を記録し、devtools の Publisher 統計の Timestamp の欄と「Copy for LLM」、`getStats().audio.timestampOffset` に出すようにして測った。実リレー (sora-moq) へ、同じ devtools のページから配信と購読を行った。

- 偽のマイク (Chromium の fake device。完全な Chromium の新しい headless で使える): 5 分間 (17,900 個の観測) で最小 1791541063773.3 ms・最大 1791541063782.9 ms (幅 9.6 ms)、10 秒と 60 秒の傾きはどちらも 0.0 ms/秒だった。増加は最初の 1 秒だけで、以後は一定である
- Web Audio のダミー音声: 30 秒の観測で幅 15 ms、傾き 0.0 ms/秒。同じく一定である
- したがって、この環境のオフセットは「一定」であり、ドリフトも段差も出なかった。一定でも、時計のずれ (この環境では約 0 ms) と読み出しの遅れ (最小値は実測で約 10 ms) の和がそのまま TIMESTAMP に載るため、受信側の音声の基準の遅れ (`avSync.delays.audio.baseDelayMs`) は修正前で 28.6〜31.0 ms になっていた
- 本物のマイクの実測 (2026-10-09、配信と購読は同じブラウザ) では、セッション前半が 37〜40 ms、途中で +485〜627 ms の段差でずれた。一定だけでなく段差でも受信側の値が動かないことを、段差と遅れの増加を分ける規則 (下記) と単体テストで固定した
- 以前に試した「読み出した時刻そのものを TIMESTAMP にする」方式は、この環境では `unobserved` を再現しなかった。同じ devtools のページで revert 前の実装 (読み出した壁時計を chunk の timestamp で引く Map と、記録が無いときの従来の換算へのフォールバック) を動かすと、`baseDelayMs` は 18.6〜20.3 ms のまま出て、代わりに A/V のずれ (`avSync.skewMs`) が −73.9 ms になった (壁時計から作った場合は −9.0 ms)。受信側が `-` を出すのは、復号の出力が再生の時間軸へ記録されないとき (音声の再生を有効にしていない、または復号の出力の timestamp が `audioTimestampKinds` に無いとき) であり、同じページで音声の再生を無効にすると `baseDelayMs` が `-` のままになることを確かめた。読み出した時刻へ置き換える方式は、TIMESTAMP の間隔が `AudioData.timestamp` の間隔ではなく読み出しの揺らぎになる点と、Map の記録が無いときに別の時計へ落ちる点が問題であり、この方式は採らない

## 解決方法

- `AudioData.timestamp` の刻み (サンプルの間隔) はそのまま使い、原点 (オフセット) だけを壁時計へ合わせる (`src/audioTimestampClock.ts` の `AudioTimestampClock`)。オフセットは「読み出した壁時計 - `AudioData.timestamp`」であり、時計のずれと「撮ってから読むまでの遅れ (0 以上)」の和である。その直近 2 秒の最小値を補正として TIMESTAMP に足す
  - 最小値へ合わせるのは、ゆっくりしたドリフトにも補正が追従し、補正が実際より大きくなって TIMESTAMP が未来へずれる (受信側の再生の目標が過去になり音が捨てられる) のを避けられるためである
  - 段差 (音声の時計そのものが飛んだ) は、直近 0.5 秒の最小値が適用中の補正より `AUDIO_TIMESTAMP_OFFSET_STEP_MICROS` (200 ms) 以上大きい状態が `AUDIO_TIMESTAMP_OFFSET_STEP_WINDOW_MS` (0.5 秒) 続いたときに取り直す。2 秒の窓が埋まるのを待つと、その間だけ TIMESTAMP が実際より古くなり、受信側の再生の目標が過去へずれて音が捨てられる
  - 読み出した時刻そのものを送る方式との違いは、①補正が記録のたびに少しずつしか動かないため、送る TIMESTAMP の間隔が `AudioData.timestamp` の間隔のままになる、②chunk の timestamp で引く Map とフォールバックを使わないため、1 つのストリームに 2 つの時計が混ざらない、の 2 点である
- `devtools/src/hooks/usePublisher.ts` と `src/createMediaPublisher.ts` の両方で、読み出し時に記録し、符号化された chunk の TIMESTAMP をこの補正で作る。音声を配信し直すたびに観測と補正を作り直す
- 計測を `AudioStats.timestampOffset` (`AudioTimestampOffsetStats`) として公開し (現在値・最小・最大・10 秒 / 60 秒の傾き・足している補正・観測数)、devtools の Publisher 統計の Timestamp の欄と「Copy for LLM」にも出す。一定なら傾きが 0、ドリフトなら 0 から離れ、段差なら最小と最大の差が開く
- 受信側 (`src/playbackTimeline.ts` / `src/audioPlayout.ts` / 購読側) は変更しない

### 確認

- 実リレーの E2E `tests/e2e/relay/audio-timestamp.spec.ts` を追加した。同じ devtools のページから偽のマイクと Canvas の映像を配信し、同じページで購読して、受信側の音声の再生を有効にしたうえで 15 秒間 `avSync.delays.audio.baseDelayMs` を観測する
  - 修正前は 28.6〜31.0 ms で「10〜30 ms に収まる」が落ちる (`Received: 31` で失敗)。修正後は 18.1〜23.9 ms で、動きの幅は 1 ms 以内、`unobserved` にならず、基準を共有できている (`sharingBases: true`)
  - 映像の表示待ちの p95 は約 100 ms、音声の `playoutTiming.startDelayMs` の p95 は約 100〜190 ms で、受け入れ条件の上限 (200 ms / 400 ms) に収まる
  - 観測の間に、購読が生きていて音声を復号し続けていることも毎秒確かめる (リレー側から切れると値が古いまま固定され、段差が無いように見えてしまうため)
- 単体テスト `src/audioTimestampClock.test.ts` で、一定のずれ・ドリフト・段差 (前後とも)・読み出しの遅れのぶれ・統計の値を固定した
- devtools の E2E で、未配信では Timestamp の欄がすべて `-` になり、`window.moqtDevTools` の `audio.timestampOffset` が null になることを固定した
- `vp check` / `tsc --noEmit` / `vp test run` (3,741 件) / Playwright (chromium 106 件、relay 4 件) がすべて通る
- 残る課題: 受信側の基準の遅れは経路の最小遅延を含むため、リレーが混雑している間は 5 分間の観測で 20 ms から 35 ms へ動いた (映像の基準は 12 ms のまま)。受け入れ条件の 10〜30 ms は混雑した経路では満たせないことがある
