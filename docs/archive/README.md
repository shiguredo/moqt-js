# 調査記録

各文書は記録時点の実装、仮説、計測結果を残す。本文の「現在」「現行」「最新」は、
その記録時点を指す。現在の仕様や性能として読む場合は、対象版と採用状況を確認する。
実装の説明は [音声と映像の再生](../PLAYOUT.md)、実行手順は [再生の計測](../PLAYOUT_MEASUREMENT.md) を参照すること。

## 再生

### 2026-11-01 のレビュー対応

| 記録                                                   | 内容                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| [レビューへの対応](playout/PLAYOUT_REVIEW_FIXES.md)    | 空の分布、復旧、出力切替、再同期後の伸長、drain、48 条件の比較と追加検証 |
| [修正前の再検証](playout/PLAYOUT_REVIEW_ASSESSMENT.md) | 指摘の再現、当時の CI 失敗、推奨案をそのまま採用しなかった理由           |

### Chrome と WebRTC の比較から出力側の改善まで

| 記録                                                                  | 内容                                                |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| [Chrome の継続調査](playout/CHROME_AUDIO_PLAYOUT_INVESTIGATION.md)    | 日本語の症状、転送と再生の境界、NetEq との差の整理  |
| [日本語と時間圧縮](playout/CHROME_AUDIO_COMPRESSION_INVESTIGATION.md) | 同じ Opus の比較、圧縮位置の選択、振幅変化          |
| [途切れと予約期限](playout/CHROME_AUDIO_DROPOUT_MEASUREMENTS.md)      | 保存した入力と到着列、予約空白と実出力の照合        |
| [WebRTC との同時比較](playout/CHROME_WEBRTC_PLAYOUT_COMPARISON.md)    | 続き音の改善前を固定した 36 条件の結果              |
| [NetEq の採用判断](playout/NETEQ_PLAYOUT_ADOPTION.md)                 | 上流の調査、部分的な採用、当時の未完了範囲          |
| [続き音による改善](playout/CHROME_AUDIO_CONTINUATION_IMPROVEMENT.md)  | 未着に備えた当初の予約方式と実音への復帰            |
| [出力側の補間と負荷](playout/CHROME_AUDIO_RENDERER_IMPROVEMENT.md)    | AudioWorklet への移行、到着側の重複処理の削除、実測 |

### A/V と出力経路

| 記録                                                            | 内容                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| [A/V の低遅延化](playout/AV_LOW_LATENCY_INVESTIGATION.md)       | 回復後の待ち、日本語と Datagram 欠落、採用しなかった調整 |
| [遅延方式の比較](playout/PLAYOUT_DELAY_ALGORITHM_COMPARISON.md) | 論文を参考にした候補、起動時の学習、同じ時計での比較     |
| [DevTools の実出力経路](playout/DEVTOOLS_AUDIO_LATENCY.md)      | audio 要素の別経路から直接出力への変更と A/V の観測      |
| [映像停止の調査](playout/VIDEO_FREEZE_INVESTIGATION.md)         | 重複 timestamp、復号失敗、次のキーフレームの待機         |
| [2026 年 10 月の判断記録](playout/AV_SYNC_DECISIONS.md)         | 旧制御を含む判断の根拠、閾値、再考の条件、当時の実測     |

### 初期の原因調査

| 記録                                                                   | 内容                                     |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| [音声再生の旧概要](playout/AUDIO_PLAYOUT_RESULT.md)                    | 2026-10-29 時点の経路、計器、検証件数    |
| [ノイズの原因候補](playout/AUDIO_GLITCH_CAUSES.md)                     | A1 / B4 などの仮説、再現、未確定な範囲   |
| [出力波形の測定と改善](playout/AUDIO_PLAYOUT_QUALITY_INVESTIGATION.md) | 圧縮、補間、短音、媒体時刻と出力の不具合 |
| [遅延の下限の実測](playout/AUDIO_PLAYOUT_LATENCY.md)                   | 旧予算と閉ループ制御の実リレー計測       |
| [無音の穴と末尾](playout/AUDIO_PLAYOUT_GAPS_AND_TAIL.md)               | 2026-10-20 の欠落と末尾の原因調査        |
| [Datagram の順序逆転](playout/AUDIO_DATAGRAM_ORDERING.md)              | 2026-10-26 の到着順序と注入条件の比較    |

## 監査

- [テスト監査 (2026-10-13)](audits/TEST_AUDIT.md)
- [DevTools の debug 監査 (2026-10-18)](audits/DEBUG_AUDIT.md)

## 記録の読み方

時系列の途中では、続き音を先に予約する方式、出力側で欠落を判断する方式、
旧 GainNode の包絡など、現在は存在しない経路も説明している。
同じ名前の計器でも、予約時の推定から実出力の測定へ意味が変わったものがある。
測定表の前提と比較元を維持し、現行の定数や件数へ一括置換しない。

過去のリンク先と実装を調べる場合は、各文書が記録した revision とソースのハッシュを使う。
生データの investigation-logs/ は gitignore の対象であり、公開リポジトリに同梱した資料ではない。
