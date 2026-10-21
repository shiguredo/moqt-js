# 音声購読に絶対 LOCATION_FILTER を付けない設計制約を docs に書く

- Created: 2026-10-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-audio-demo-hardening
- Polished: {YYYY-MM-DD}

## 目的

ライブラリの音声購読は LOCATION_FILTER を送らないため、リレーの cache からの replay は
「最新 Group の先頭」= 音声 1 Object (20 ms) に収まる。将来、音声購読に絶対位置の
LOCATION_FILTER を足すと、リレーは要求範囲の先頭から cache が保持する範囲全体
(最大 72 秒分) を replay し得る。受信側は古い音声を大量に復号し、時間軸の基準学習と
A/V 同期を壊す。現状はこの前提がコードのコメントにしかなく、docs に設計制約として
書かれていない。

## 現状

- `src/createMediaSubscriber.ts` の `subscribeMediaTracks` は音声・映像とも filter 無しで
  購読する。devtools も同様
- `docs/AUDIO_PLAYOUT_RESULT.md` の「仕組み」と「既知の限界」に、購読の filter に関する
  記述は無い

## 設計方針

- `docs/AUDIO_PLAYOUT_RESULT.md` の「仕組み」または「既知の限界」に、音声購読は
  LOCATION_FILTER を送らないこと、絶対位置の filter は cache replay を巨大化させるため
  付けないことを書く
- リレーの実装名や内部仕様は書かない。仕様 (MOQT の filter と cache の考え方) と
  moqt-js の設計制約だけを書く

## 完了条件

- docs に制約と理由が書かれている
- 表記・用語が `shiguredo-doc` の規約に合っている
- `vp check` が通ること

## 解決方法

{対応時に記入}
