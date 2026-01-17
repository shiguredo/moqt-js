# 変更履歴

- CHANGE
  - 下位互換のない変更
- UPDATE
  - 下位互換がある変更
- ADD
  - 下位互換がある追加
- FIX
  - バグ修正

## develop

- [CHANGE] rolldown-vite から vite に戻す
  - rolldown でオプショナルチェーン (`?.`) が minification 時に消えるバグがあったため
  - @voluntas
- [CHANGE] draft-ietf-moq-transport-16 に対応する
  - パラメータのデルタエンコーディング対応
  - SUBSCRIBE_UPDATE を REQUEST_UPDATE に変更
  - REQUEST_ERROR に Retry Interval 追加
  - PUBLISH_NAMESPACE_DONE/CANCEL に Request ID 追加
  - PUBLISH, SUBSCRIBE_OK, FETCH_OK に Extension Headers 追加
  - Object Status の処理方法変更
  - TRACK_STATUS から配信関連パラメータ削除
  - TRACK_STATUS に LARGEST_OBJECT パラメータ追加
  - SUBSCRIBE_NAMESPACE で空/ワイルドカード namespace 許可
  - FETCH レスポンスで不明な範囲を許可
  - DELIVERY_TIMEOUT=0 を禁止
  - REQUEST_UPDATE で Start Location 減少許可
  - 同一トラックで Datagram と Stream の混在許可
  - @voluntas
- [FIX] sendObject の並行呼び出し時にストリームの二重 close() が発生する問題を修正する
  - @voluntas

### misc

- [UPDATE] moqt-devtools の Namespace フィールドに説明とプレースホルダーを追加する
  - @voluntas

## 2025.2.0

**リリース日**: 2026-01-06

- [ADD] Immutable Extensions (0x0B) の encode/decode を実装する
  - @voluntas
- [FIX] draft-15 で使用されなくなった TrackStatusCode を削除する
  - @voluntas
- [FIX] 利用していなかった StreamType 定数を削除する
  - @voluntas
- [FIX] MOQT Streaming Format 準拠で Group ID の初期値を Unix epoch ミリ秒に修正する
  - @voluntas
- [FIX] MOQT 準拠で 1 Stream 1 Group 1 SubGroup N Objects に修正する
  - @voluntas

## 2025.1.0

**リリース日**: 2025-12-31

祝 npm リリース
