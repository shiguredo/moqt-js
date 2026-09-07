# channelConfig の名前付き値で NaN になり購読開始が失敗する

- Created: 2026-09-06
- Completed: 2026-09-07
- Branch: feature/fix-channel-config-parse
- Polished: 2026-09-06

## 目的

仕様例準拠の第三者カタログ (`channelConfig: "mono"`) で `start()` が失敗し相互運用が壊れる。名前付き値に対応する必要がある。

## 現状

- `src/createMediaSubscriber.ts` は `Number.parseInt(channelConfig, 10)` でチャンネル数を得る。`"mono"` は `NaN` になり、`AudioDecoder.configure` が throw する。
- 自 Publisher は数値文字列を書くため自家運用では発現しない。
- `src/msf.ts` の `channelConfig` は `string` で値域の規定がない。

## 設計方針

1. `channelConfig` を解決関数で数値化する。対応表は `mono` → 1、`stereo` → 2、整数文字列 → その値 (1 以上の整数のみ受理) とする。照合は前後空白除去・小文字化して行う。一次資料 §4.1 の名前付き例は `mono` のみであり、`stereo` は慣用値として本 issue で定める。
2. 上記以外 (未知の名前・非整数・0 以下・空文字列の明示値) は `setupDecoders` で `throw` し、`start()` を失敗させる (`onError` 通知後の再 `throw` が既定動作)。解決は `configure` 呼び出し前に行い、`NaN` をデコーダに渡さない。
3. 解決前後の値のテストを追加する (`mono` / `stereo` / `1` / `2` / 未知値)。

## 完了条件

- `"mono"` / `"stereo"` / 整数文字列のカタログで `setupDecoders` が成功すること。
- 未知値のカタログで `start()` が `throw` すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

- カタログ channelConfig の解決関数を追加し、mono / stereo と 1 以上の整数文字列 (safe integer 範囲内) を数値化する。解決不能な明示値は NaN を渡さず throw する
- 解決前後のテスト 9 件を追加した。旧コードで落ちることを確認した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した

## 関連

- refs/moq/draft-ietf-moq-loc-04.txt §4.1
