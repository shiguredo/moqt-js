# 音声回りのコメントから外部実装名への言及を外す

- Created: 2026-10-01
- Completed: {YYYY-MM-DD}
- Branch: feature/update-remove-implementation-names
- Polished: {YYYY-MM-DD}

## 目的

`src/` と `devtools/` の音声同期のコメントが、特定の外部実装 (`libwebrtc` とその `NetEq`) のソースファイル名・クラス名 (`time_stretch.cc` / `delay_manager.cc` / `stream_synchronization.cc` など) を移植元の根拠として引用している。読む人は外部実装の全体像を知っている前提を要求され、このリポジトリの実装が何をするものかはコメントから読み取れない。規則そのもの (周期の探索範囲、相関閾値、分位点、不感帯、変更の上限など) を自前の言葉で説明し、外部実装名への言及を外す。

## 現状

- 外部実装名 (`libwebrtc` / `NetEq`) と外部ソースのファイル名が次のファイルのコメントに残っている
  - `src/audioTimeStretch.ts` / `src/audioTimeStretch.test.ts`
  - `src/audioDelayManager.ts`
  - `src/streamSynchronization.ts`
  - `src/playbackTimeline.ts` / `src/playbackTimeline.test.ts` / `src/playbackTimeline.prop.ts`
  - `src/audioPlayout.ts` / `src/audioPlayout.test.ts`
  - `src/createMediaSubscriber.ts`
  - `devtools/src/hooks/useSubscriber.ts`
- 直近の変更で新規に追加したコメントは外部実装名を使っていない。古いコメントに残っている
- `refs/` に該当実装の一次資料は無く、引用の正しさをこのリポジトリで確認する手段は無い

## 設計方針

- コメントを、規則 (探索するラグの範囲、相関閾値 0.9、0.95 分位、不感帯 30 ms、1 回の変更の上限 80 ms、クロスフェードの重み、バケットの幅と忘却係数など) と、このリポジトリでの役割の説明に書き換える。外部実装名とそのファイル名・クラス名・定数名は書かない
- テストのコメントとテスト名も同様にする。テストの期待値・テスト名の意味は変えない
- 一次資料で確認できない固有名詞の引用は削る
- 挙動は変えない (コメントのみの変更)

## 完了条件

- `rg -i 'libwebrtc|neteq' src devtools tests` が 0 件になること (変更履歴・issue ファイルは対象外)
- 各コメントが規則と役割を自前の言葉で説明していること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

{未着手}
