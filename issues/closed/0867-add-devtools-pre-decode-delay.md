# moqt-devtools の購読側に動的な再生遅延の設定を追加する

- Created: 2026-10-19
- Completed: 2026-10-19
- Branch: feature/add-pre-decode-delay
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の Subscriber で、再生遅延を接続中に動的に変更できるようにする。ライブラリの `MediaSubscriberOptions.preDecodeDelayMs` は生成時に固定されるため、devtools のように購読を止めずに設定を変えて挙動を確かめたい用途では使えない。

受信した Object を復号前に時間で保持する仕組みは `src/playout/preDecodeDelay.ts` の `PreDecodeDelayQueue` として共有済みである。devtools は低レベル API の `Subscriber` を使うため、このキューを devtools の音声・映像の受信経路へ直接組み込み、設定の変更を即座に反映する。

## 現状

- moqt-devtools の Subscriber は `devtools/src/hooks/useSubscriber.ts` で低レベル API の `Subscriber` を使い、音声と映像の Object を Promise チェーンで復号へ渡している。
- 映像は `videoGroupGateRef` を通した後に `handleObject` で復号し、音声は `handleAudioObject` で復号する。復号前の遅延キューは無い。
- 設定は `devtools/src/signals/connectionSettings.ts` の signal と URL クエリで管理している。Subscriber の設定は接続中に `settingsDisabled` で無効化されるため、動的に変更できる設定は無い。
- ライブラリの `MediaSubscriberImpl` は `preDecodeDelayMs` を生成時に検証して固定し、購読中の変更 API を持たない。

## 設計方針

### 共有キューの動的変更

- `PreDecodeDelayQueue` の期限を「積んだ時刻 + 遅延」で計算する形に変え、`setDelayMs(value)` を追加する。遅延を変えると保持中の Object の期限も新しい値で計算し直す。
- 遅延を 0 にしたときは `takeAll()` で保持中の Object をすべて取り出し、待たずに復号チェーンへ流す (ライブへ追いつく)。0 から大きくしたときは新しいキューを作る。
- `setDelayMs` は生成時と同じ検証 (有限数、0 以上、`MAX_PRE_DECODE_DELAY_MS` 以下) を行う。

### devtools の設定

- `connectionSettings.ts` に `preDecodeDelayMs` signal を追加する。選択肢は 0 / 500 / 1,000 / 2,000 / 3,000 / 5,000 / 10,000 ms とする。
- URL クエリ `preDecodeDelayMs` で復元・共有できるようにする。既定の 0 は URL に載せない。
- `connectionSettingsSnapshot.ts` に `preDecodeDelayMs` を追加する。
- Subscriber の設定画面に `Playback delay` の select を追加する。この設定だけは接続中も変更できるようにし、`settingsDisabled` では無効化しない。
- `useSubscriber.ts` で設定の signal を監視し、購読中に変わったら音声と映像の復号前キューへ即座に反映する。

### 音声と映像の経路

- 映像: `enqueueVideoObjects` で Group の切り替えの保留を抜けた `ReceivedVideoObject` を復号前キューへ積む。到着時刻 (`receivedAtMs`) は既に記録済みなので、遅延後も `PlayoutTimingStats` の到着と復号の区間を正しく測れる。タイマーで期限が来たら `handleObject` を Promise チェーンへ積む。
- 音声: `queueAudioObject` で Object を復号前キューへ積む。`handleAudioObject` に到着時刻を渡し、受信の遅れ (`audio.receiveDelayMs` と入力の遅れ) を復号時ではなく到着時点の値で測る。期限が来たら音声の Promise チェーンへ積む。
- 音声と映像で別々のキューとタイマーを持つ。キュー上限超過時は古い Object から落とし、購読期間あたりメディアごとに 1 回だけ警告ログを残す。
- 購読開始時に現在の設定でキューを作り、停止・中断・アンマウント時にキューとタイマーを破棄する。
- 遅延を 0 から大きくしたとき、保持中の Object が無ければキューを作る。大きくした時点から受信する Object が対象になる。
- 遅延を小さくしたときは、保持中の Object の期限を新しい値で計算し直してタイマーを張り直す。0 にしたときは `takeAll()` で待たずに流す。

### 高レベル API との関係

- ライブラリの `MediaSubscriberOptions.preDecodeDelayMs` は生成時に固定する。この issue では購読中の変更 API をライブラリへ追加しない。
- devtools は共有の `PreDecodeDelayQueue` を使って動的に変更する。ライブラリと devtools で遅延の計算と上限の規則を共有する。

## 完了条件

- moqt-devtools の Subscriber の設定画面に `Playback Delay (Audio + Video)` があり、0 / 500 / 1,000 / 2,000 / 3,000 / 5,000 / 10,000 ms から選べる。
- 接続中に設定を変えると、購読を止めずに音声と映像の復号開始が変わる。0 に戻すと保持中の Object が待たずに復号へ流れる。
- 遅延中の映像の `latency` は遅延の分を含んだ値になる。音声の `receiveDelayMs` は到着時点で測る値であり、遅延の分を含まない (入力の遅れとして追いつきの判定に使い、意図した遅延は別に差し引く)。
- URL クエリ `preDecodeDelayMs` で設定が復元され、Copy URL で書き出される。既定の 0 は載らない。
- 設定の snapshot に `preDecodeDelayMs` が含まれる。
- 購読の停止・開始・失敗・アンマウントでキューとタイマーが残らない。
- `PreDecodeDelayQueue` の `setDelayMs` と `takeAll` の単体テスト、devtools の設定と URL のテスト、動的変更のテストを追加する。モックやスタブは使わない。
- `vp fmt --write .` / `tsc --noEmit` / `vp lint` / `vp test run` / `vp run build` が通る。
- `docs/PLAYOUT_DELAY.md` と README の devtools の機能一覧を更新する。`CHANGES.md` は MOQT RFC ドラフト中のため更新しない。

## 参照

- `src/playout/preDecodeDelay.ts` の `PreDecodeDelayQueue` / `MAX_PRE_DECODE_DELAY_MS`
- `devtools/src/hooks/useSubscriber.ts` の `enqueueVideoObjects` / `queueAudioObject` / `handleObject` / `handleAudioObject`
- `devtools/src/signals/connectionSettings.ts` の `settingsDisabled` / `buildQueryParams` / `initFromUrl`
- `devtools/src/signals/connectionSettingsSnapshot.ts`
- `devtools/src/components/ConnectionSettings.tsx` の Jitter Buffer の設定
- `devtools/src/utils/playoutTimingStats.ts` の `recordArrival` / `recordDecodeStart`
- `issues/closed/0866-add-pre-decode-delay.md` (ライブラリ側の復号前遅延)

## 解決方法

- `src/playout/preDecodeDelay.ts` の `PreDecodeDelayQueue` を、期限を「積んだ時刻 + 現在の遅延」で計算する形に変え、`setDelayMs(value)` と `takeAll()` を追加した。遅延を変えると保持中の Object の期限も新しい値で計算し直し、0 にしたときは `takeAll()` で待たずに取り出せる。`setDelayMs` も生成時と同じ検証を行う。
- `devtools/src/signals/connectionSettings.ts` に `preDecodeDelayMs` signal と `PRE_DECODE_DELAY_OPTIONS` (Off / 500 / 1,000 / 2,000 / 3,000 / 5,000 / 10,000 ms) を追加した。URL クエリ `preDecodeDelayMs` の復元と Copy URL への書き出しに対応した。
- `devtools/src/signals/connectionSettingsSnapshot.ts` に `preDecodeDelayMs` を追加した。
- `devtools/src/components/ConnectionSettings.tsx` の Subscriber 設定に `Playback Delay` の select を追加した。この設定だけは `settingsDisabled` で無効化せず、接続中も変更できる。
- `devtools/src/hooks/useSubscriber.ts` で、音声と映像の復号前キューとタイマーを ref で持ち、設定の signal を `useSignalEffect` で監視するようにした。購読開始時に現在の設定でキューを作り、設定変更時は `setDelayMs` で期限を計算し直してタイマーを張り直す。0 にしたときは保持中の Object を復号チェーンへ流してキューをやめる。停止・中断・アンマウントではキューとタイマーを破棄する。
- 設定変更時は `PlayoutTimeline.reset()` で表示時刻の基準を取り直し、表示待ちのフレームも捨てる。基準の遅れは直近 10 秒の最小値であり、古い基準のままだと表示時刻が遅延の分だけ前になり、映像が捨てられるためである。
- 映像は `enqueueVideoObjects` で Group の切り替えの保留を抜けた Object をキューへ積み、期限後に `handleObject` を Promise チェーンへ積む。到着時刻は受信時に記録済みなので、遅延の分が復号の遅れとして混ざらない。
- 音声は `queueAudioObject` で Object をキューへ積み、期限後に `handleAudioObject` を音声の Promise チェーンへ積む。`handleAudioObject` は到着時刻を引数で受け取り、受信の遅れ (`audio.receiveDelayMs` と入力の遅れ) を到着時点の値で測る。
- キュー上限超過時は古い Object から落とし、購読期間あたりメディアごとに 1 回だけ警告ログを残す。
- `src/playout/preDecodeDelay.test.ts` に `setDelayMs` の延長・短縮・順序・不正値と `takeAll` のテストを追加した。`devtools/src/signals/connectionSettings.test.ts` と `connectionSettingsSnapshot.test.ts` に設定と URL のテストを追加した。`tests/e2e/devtools-playback-delay.spec.ts` で既定値・UI からの変更・Copy URL・URL からの復元を確認した。モックやスタブは使っていない。動的変更の配線は、レビューでの修正で `devtools/src/hooks/subscriberPreDecodeDelay.test.ts` と `src/playout/preDecodeDelayStage.test.ts` を追加して固定した。
- `docs/PLAYOUT_DELAY.md` に moqt-devtools での動的設定の節を追加し、README の devtools の機能一覧に Playback Delay を追加した。
- `vp fmt --write .` / `tsc --noEmit` / `vp lint` / `vp test run` (233 ファイル、4103 テスト成功) / `vp run build` / `vp exec playwright test --project=chromium tests/e2e/devtools-playback-delay.spec.ts` が通ることを確認した。
- 実リレーに接続したまま Playback Delay を変えたときの表示遅延は E2E で測っていない。キューの期限計算と devtools の適用経路はテストで固定しているが、実リレーでの計測は今後の確認項目とする。

## レビューでの修正 (2026-10-20)

差分レビュー (review-diff-code) の指摘を受けて、次の点を修正した。

- `AudioPlayoutSession.handleDecodedAudio` に `intentionalDelayMs` を渡すようにした。渡さないと、購読中に遅延を変えたとき (購読開始時から遅延がある場合も含む) に音声の受信側追いつきが意図した遅延を復号器の詰まりと誤判定し、復号器を 1 秒おきに作り直す。値は設定値ではなく、その Object を実際に保持した時間を使う。
- 遅延を変えたときに音声の追いつきの観測を消すようにした。床 (直近の遅れの最小値) が古い遅延のまま残ると、変更後の最初の復号出力を詰まりと誤判定する。
- 復号前の段を `src/playout/preDecodeDelayStage.ts` の `PreDecodeDelayStage` にまとめ、音声と映像、停止・再開の重複した配線を無くした。動的変更の配線は `devtools/src/hooks/subscriberPreDecodeDelay.ts` に切り出し、`devtools/src/hooks/subscriberPreDecodeDelay.test.ts` で 0 からの作成・増減・0 への flush・停止時の破棄・上限超過の通知を固定した。
- 設定画面のラベルを `Playback Delay (Audio + Video)` にし、音声と映像の両方に効くことを示した。
- 上限超過で遅延が短くなったときは、音声と映像の短縮量を揃えて A/V 同期を保つようにした。
- 短縮した遅延はキューが空になったら解除する。期限は各 Object を積んだ時点で決めて保持し、短縮を時間で解消しない (時間で解消すると、保持中の Object の期限が時間と一緒に動いて取り出せなくなる)。
