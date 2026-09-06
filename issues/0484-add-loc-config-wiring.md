# 高レベル API で Video / Audio Config を送受信する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/add-loc-config-wiring
- Polished: YYYY-MM-DD

## 目的

`VIDEO_CONFIG` / `AUDIO_CONFIG` が高レベル API で配線されず、canonical 運用や解像度変更時の再構成が成立しない。送受信とデコーダ反映が必要である。

## 現状

- `src/codec/VideoEncoder.ts` の出力は `description` を取り出すが、`src/createMediaPublisher.ts` のハンドラ型は受け取らず `VIDEO_CONFIG` を送信しない。
- `src/createMediaSubscriber.ts` の `setupDecoders` は幅・高さのみで構成し、Object / Track の `config` を使わない。カタログ更新時の再構成もない。
- `annexb` 固定のため当面動くが、`avc1` / `hvc1` の canonical 運用は成立しない。

## 設計方針

1. 送信側で `description` を `VIDEO_CONFIG` (`AUDIO_CONFIG` は encoder 対応後に) として送る。
2. 受信側で初回構成と `config` 変化時の再構成を行う。
3. 音声 encoder の `description` 取得も合わせて対応する。

## 完了条件

- `description` が送受信されデコーダ構成に反映されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- refs/moq/draft-ietf-moq-loc-04.txt §2.1.2 / §2.3.2.1 / §2.3.3.1
