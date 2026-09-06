# channelConfig の名前付き値で NaN になり購読開始が失敗する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-channel-config-parse
- Polished: YYYY-MM-DD

## 目的

仕様例準拠の第三者カタログ (`channelConfig: "mono"`) で `start()` が失敗し相互運用が壊れる。名前付き値に対応する必要がある。

## 現状

- `src/createMediaSubscriber.ts` は `Number.parseInt(channelConfig, 10)` でチャンネル数を得る。`"mono"` は `NaN` になり、`AudioDecoder.configure` が throw する。
- 自 Publisher は数値文字列を書くため自家運用では発現しない。
- `src/msf.ts` の `channelConfig` は `string` で値域の規定がない。

## 設計方針

1. 名前付き値 (`mono` / `stereo` 等) を数値に解決し、未知値は明示的に失敗させる。
2. 仕様例値でのテストを追加する。

## 完了条件

- `"mono"` 等の名前付きカタログで購読開始できること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- refs/moq/draft-ietf-moq-loc-04.txt §4.1
