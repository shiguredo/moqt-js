# Shaka Player の LOC 映像バッファの周期的な消失

2026-11-24 に、同じ配信を Shaka Player と moqt-devtools の Subscriber で同時に受けた。
キーフレーム間隔が 10 秒の場合、Shaka Player は各キーフレームの約 6 秒後に映像バッファを失い、
次のキーフレームまで約 4 秒止まった。Subscriber の Canvas 描画はその間も続いた。

## 再現手順

1. moqt-devtools の Publisher で AV1 のダミー映像を 1280 × 720 / 30 fps / 1 Mbps、音声なし、
   Keyframe Interval を 10 秒にして、実リレーへ配信する
2. 同じ Track Namespace を moqt-devtools の Subscriber と Shaka Player から購読する。Shaka Player は
   Draft-23 を指定する。Buffer Eviction Goal がある版では、Shaka 本体の既定値と同じ 1 秒を指定する
3. 最初の再生から 30 秒程度、Shaka Player の `getBufferedInfo().video`、`requestVideoFrameCallback()`、`segmentappended` と、Subscriber の Canvas 描画を観測する
4. Publisher の Keyframe Interval だけを 2 秒に変えて配信し直し、同様に観測する

Linux のヘッドレス Chromium で、同梱版 `v5.3.6-main-13-gef7e1bf63` を利用した。配備済みの
Shaka Player でも、AV1 と Opus (Subgroup) の組み合わせで同じ周期の映像バッファ消失を確認した。
音声は再現に必要ない。H.264 は今回の同梱版で再生開始時にエラー (3016、続いて 3014) が
発生したため、周期停止は比較できていない。

## 観測結果

| Shaka Player 同梱版の条件                                        |   観測時間 | 映像バッファと描画                                                       |
| ---------------------------------------------------------------- | ---------: | ------------------------------------------------------------------------ |
| キーフレーム間隔 10 秒、既定の `streaming.evictionGoal` (1 秒)   |   約 30 秒 | 映像バッファの消失による約 4 秒の停止が 3 回                             |
| キーフレーム間隔 2 秒、既定設定                                  | 約 37.5 秒 | 映像の削除要求 16 回。削除による空バッファと `gapjumped` はいずれも 0 回 |
| キーフレーム間隔 10 秒、`streaming.evictionGoal` だけ 8 秒に変更 | 約 37.5 秒 | 映像バッファの消失と `gapjumped` はいずれも 0 回                         |

3 回の長い停止を引き起こした `SourceBuffer.remove()` の削除要求は、いずれもバッファ先頭の
約 1.03 秒だった。各呼び出し直前には約 6.00 秒分の連続した映像があり、呼び出しに対応する
`updateend` 時点では空だった。最初の停止中も Shaka Player は約 120 件の映像 `segmentappended`
を通知した。Subscriber は映像 Object の欠落を報告せず、Canvas 描画の間隔が 100 ms を超えなかった。

## 原因

`MSFParser.updateAvailabilityWindow_()` は、Media Timeline のない今回の LOC 配信で、4 秒の
シーク範囲を使った。`StreamingEngine.evict_()` は、通常の後方保持量 (`streaming.bufferBehind`、
既定 30 秒) とは別に、シーク範囲の先頭を基準に削除量を計算する。シーク範囲の長さが
`streaming.evictionGoal` より大きく、その範囲の先頭が映像バッファの先頭から
`2 × streaming.evictionGoal` を超えて進むと、この削除経路が動く。今回の既定設定では、
ライブ先端がバッファ先頭から約 `4 + 2 × 1 = 6` 秒進んだ時点に当たる。
`streaming.evictionGoal` を 8 秒にした対照条件では、4 秒のシーク範囲がその値を超えず、
この経路は動かない。

Shaka Player は次のフレームを追加する前に削除を実行する。
[Media Source Extensions §5.5.9 Coded Frame Removal](https://w3c.github.io/media-source/#sourcebuffer-coded-frame-removal)
の削除処理は、要求区間の終端以降にバッファ済みのランダムアクセスポイントがある場合はそこまで、
ない場合は残りのデータも削除し得る。10 秒の条件では、削除が次のキーフレームの追加より早く、
再生中の GOP (キーフレームから次のキーフレームまでの区間) ごと消えた。以後の差分フレームでは
復号を再開できず、次のキーフレームで再開した。

moqt-devtools の Subscriber は WebCodecs で復号して Canvas に描き、同じ `SourceBuffer` の
削除処理を通らない。

## 回避と修正の方向

Publisher の Keyframe Interval を 2 秒にすると、今回の比較では周期停止を回避できた。
`streaming.evictionGoal` の変更は削除条件を切り分けるための対照で、固定値で GOP 長や保持量を
保証するものではない。

恒久対策の候補は、LOC 映像の後方削除で、再生位置より前にあり、実際に Media Source Extensions
(MSE) のバッファに残っている最新のキーフレームより先まで削除しないこと。安全な削除境界が
ないときは削除を待つ。シーク範囲の長さを変更するだけでは、さらに長い GOP で同じ問題が
起き得る。

## ページ側の設定追加後の確認

DevTools の Shaka Player ページに Buffer Eviction Goal を追加し、既定を 8 秒にした。
Shaka 本体や Publisher のコードは変更していない。AV1、音声なし、キーフレーム間隔 10 秒の
まま、ビルドしたページを Linux のヘッドレス Chromium で実リレーに接続して比較した。

- 既定 8 秒: 約 67.6 秒の観測でキーフレームを 7 回生成し、Shaka Player は 2,023 フレームを提示した。約 38、48、58 秒で映像バッファを削除したが、いずれも空にならず、再生中の `gapjumped` は 0 回
- 画面から 1 秒を指定: 約 6 秒で映像バッファが空になり、次のキーフレームまで約 4 秒停止する現象が再現
- 既定 8 秒で Opus (Subgroup) を追加: 約 52.5 秒の観測で、初回再生位置の調整後に映像バッファの消失や `gapjumped` は発生しなかった
