# channelConfig のサラウンド複合表記に対応する

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/add-channel-config-surround
- Polished: YYYY-MM-DD

## 目的

サラウンド系カタログ (`channelConfig: "5.1"` 等) で購読開始が失敗する。複合表記に対応して相互運用を広げる必要がある。

## 現状

- チャンネル数解決は `mono` / `stereo` / 整数文字列のみ受理し、複合表記は解決不能として `throw` する。
- 値語彙を定める一次資料は存在せず、製品判断でマッピングを定める必要がある。候補は `5.1` → 6、`7.1` → 8 である。
- 自 PBT は `5.1` / `7.1` を正規値として生成するため、現状は生成値が購読層で拒否される不整合がある。

## 設計方針

1. 受理する複合表記とチャンネル数の対応表を定め、解決関数に追加する。
2. 対応表の根拠 (業界慣用等) をコメントに残す。

## 完了条件

- 複合表記のカタログで購読開始が成功すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-msf-01 §5.2.29
- draft-ietf-moq-loc-04 §4.1
