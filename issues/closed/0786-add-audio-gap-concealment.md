# 音声の欠落で空いた隙間を直前の音の時間伸長で補間する

- Created: 2026-10-01
- Completed: 2026-10-01
- Branch: feature/add-audio-gap-concealment
- Polished: 2026-10-01

## 目的

音声の Object が欠落したときや、時間軸の目標の遅延が増えたときに、前の音の終わりと次の音の開始の間に無音の隙間ができる。欠落した音の区間を直前の音から作った補間で埋め (expand)、溜まりが足りないときは先に伸ばして貯める (preemptive expand) 方式では、音が途切れない。ここでも同じように、隙間を直前の音の時間伸長で埋めて無音を作らない。この実装では expand と preemptive expand のどちらも「前の音の終わりと次の音の開始の間の隙間」として現れるため、同じ補間で扱う。

## 現状

- `src/audioTimeStretch.ts` の `expandSamples` はピッチ周期 1 つ分を挿す時間伸長を実装済みだが、production の呼び出しが無く、`src/audioTimeStretch.test.ts` でだけ使われている
- `src/audioPlayout.ts` の `AudioPlayoutScheduler.schedule` は、前の音の終わり (`lastEnd`) と今回の開始時刻 (`startAt`) の間の隙間を無音のまま残す。`src/audioPlayout.test.ts` の「目標を使わないときは音が抜けた分の無音を残す」が現在の意図を固定している
- 目標を守るとき (`enforceTarget`) は、timestamp が飛んだ場合も、`src/playbackTimeline.ts` の `PlaybackTimeline` が目標の遅延を増やした場合も、同じように隙間が空く
- `src/createMediaSubscriber.ts` の `handleAudioDecodedData` と `devtools/src/hooks/useSubscriber.ts` の `handleAudioDecoded` は、復号した音をその場で予約して手放しており、隙間を埋めるための直前の音を保持していない
- 完全な expand は波形の周期を使う補間だけでなく、有声音 / 無声音の切り替え、背景ノイズ、連続する expand に応じたミュートを含む。ここに必要なのは「直前の音の末尾を、隙間の長さぶんだけ自然に伸ばす」部分である

## 設計方針

- 5 ms を超える隙間を補間の対象にする (`AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS`)。それ未満は補間の継ぎ目が耳につくため補間せず、無音のまま残す
- 補間する長さの上限は 100 ms にする (`AUDIO_PLAYOUT_MAX_CONCEAL_SECONDS`)。上限を超える分は無音のままにする。連続する expand ではミュートを強めて長い欠落を無音へ近づける方式があり、補間が長くなるときは振幅を徐々に下げる
- `AudioPlayoutScheduler` は、鳴らすと決めた音について「前の音の終わり」と「今回の開始時刻」の差を `gapSeconds` と `gapStartSeconds` として返す。目標を使わない到着基準の並べ方でも同じ情報を返す
- 補間は直前の音の末尾から作る。`src/audioTimeStretch.ts` に、既存のピッチ解析 (4 kHz への間引き、自己相関、0.9 の相関閾値、クロスフェード) を使い、末尾のピッチ周期を必要な長さまで繰り返す関数を追加する。既存の `expandSamples` は音の中央に 1 周期挿す操作であり、末尾を伸ばす用途にはそのまま使えないため、共通の解析を使って実装する。相関が足りない音では操作しない規則は `expandSamples` と同じにする
- 補間した音は別の `AudioBufferSourceNode` として `gapStartSeconds` に予約する。直前の音の終わりと補間の先頭が繋がるように、補間の先頭は末尾の波形の続きから始める
- 呼び出し側 (`handleAudioDecodedData` / `handleAudioDecoded`) は直前に鳴らした音のチャンネルごとのサンプルとサンプルレートを保持する
- 隙間の開始が今 + `AUDIO_PLAYOUT_MIN_LEAD_SECONDS` より前の場合は予約できないため、`AudioPlayoutScheduler` は隙間の情報を返さず補間しない (過去の隙間もこれに含まれる)
- 補間は隙間の中に収まり、次の音の開始時刻は変えない (`AudioPlayoutScheduler` の `lastEnd` の計算は変えない)
- 補間した回数と長さは、実際に補間できた量だけを数える。`confirmStretch` と同じ形で、呼び出し側が適用した長さを返す口 (`confirmConcealment` など) を `AudioPlayoutScheduler` に作り、相関が足りない / 上限を超えた / 予約できない場合は数えない
- 数えた値は `AudioPlayoutScheduler` の getter までとし、ライブラリの統計への公開は 0787 で行う。devtools の画面表示も 0786 の対象外とする
- `src/audioPlayout.test.ts` の「目標を使わないときは音が抜けた分の無音を残す」は、到着基準でも補間する規則に合わせて書き換える (間隔を保つ確認は残し、隙間の情報を確かめる)。`AudioPlayoutDecision` の形を `assert.deepEqual` で固定しているテストも更新する

## 完了条件

- Object が 1 つ欠落した入力で、隙間が直前の音の時間伸長で埋まり、無音にならないこと
- 隙間の長さが上限を超えるときは、上限の分だけ補間して残りは無音になること
- 相関が足りない音 (周期が無い音) では補間しないこと
- 隙間の開始が今 + `AUDIO_PLAYOUT_MIN_LEAD_SECONDS` より前のときは補間しないこと
- 到着基準の並べ方でも同じ規則で補間すること
- 補間の有無で、後続の音の開始時刻 (目標) が変わらないこと
- 補間の統計が、実際に補間できた長さだけを数えること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

- `src/audioTimeStretch.ts` に `concealSamples` を追加した。末尾の 2 周期分の正規化相関から末尾で繰り返している周期を探し (`findTailLag`)、末尾の周期を必要な長さまで繰り返して補間する。相関が `TIME_STRETCH_CORRELATION_THRESHOLD` 未満の音と、継ぎ目の段差が末尾の周期内の最大段差の `TIME_STRETCH_MAX_SEAM_STEP_RATIO` (2) 倍を超える音では補間しない。無音は補間し、生成した音の末尾は `endGain` まで徐々に振幅を下げる
- `src/audioPlayout.ts` は、前の音の終わりと今回の開始の間の隙間を `gapStartSeconds` / `gapSeconds` として返す。5 ms 以下と、開始が今 + 余裕より前の隙間は返さず、上限 100 ms で切る。`confirmConcealment` が実際に補間した長さだけを数え、`concealments` / `concealed` で読める。`lastEnd` は変えない。長い補間ほど末尾の振幅を下げる規則は `concealmentEndGain` に集約した
- `src/createMediaSubscriber.ts` は直前に鳴らした音を保持し、隙間があれば別の `AudioBufferSourceNode` として隙間の開始時刻に予約して補間した長さを返す。停止と AudioContext の作り直しで保持を消す。`devtools/src/hooks/useSubscriber.ts` も同じ配線にした
- テスト: `src/audioTimeStretch.test.ts` に周期的な音・無音・位相反転・ランプ・周期変化・16 kHz・境界を、`src/audioPlayout.test.ts` に隙間の検出・下限と上限の境界・今 + 余裕の境界・捨てた後の隙間・統計のクランプとリセット・減衰を、`src/audioPlayout.prop.ts` に隙間の不変条件を、`src/createMediaSubscriber.test.ts` に補間の予約を追加した
- `vp check` / `tsc --noEmit` / 全 3550 テストが通った
