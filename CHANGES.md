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
- [FIX] sendObject の並行呼び出し時にストリームの二重 close() が発生する問題を修正する
  - @voluntas
- [CHANGE] draft-ietf-moq-transport-17 に対応する
  - 可変長整数エンコーディングを QUIC varint から MOQT varint に変更
  - 制御ストリームを双方向から単方向ペアに変更
  - CLIENT_SETUP/SERVER_SETUP を単一 SETUP メッセージに統合
  - リクエスト (SUBSCRIBE/PUBLISH/FETCH) を双方向ストリームに移動
  - MAX_REQUEST_ID/REQUESTS_BLOCKED メッセージを削除
  - SUBSCRIBE/PUBLISH/FETCH に Required Request ID Delta フィールドを追加
  - REQUEST_OK/REQUEST_ERROR から Request ID フィールドを削除
  - GOAWAY に Timeout フィールドを追加
  - PUBLISH_BLOCKED メッセージを追加
  - SUBSCRIBE に RENDEZVOUS_TIMEOUT パラメータを追加
  - 新エラーコードを追加 (GOING_AWAY / EXCESSIVE_LOAD / NAMESPACE_TOO_LARGE / TOO_FAR_BEHIND)
  - DELIVERY_TIMEOUT=0 を許可 (タイムアウトなし)
  - Subscription Filter の EndGroup をデルタエンコーディングに変更
  - Extension Headers を Properties にリネーム
  - Setup Parameters を Setup Options にリネーム
  - GREASE 値の判定・生成を実装
  - Property Type のアプリケーション用範囲 (0x3800-0x3FFF) を予約
  - SUBSCRIBE_UPDATE を REQUEST_UPDATE に変更
  - REQUEST_ERROR に Retry Interval 追加
  - PUBLISH_NAMESPACE_DONE/CANCEL に Request ID 追加
  - Object Status の処理方法変更
  - TRACK_STATUS から配信関連パラメータ削除
  - TRACK_STATUS に LARGEST_OBJECT パラメータ追加
  - SUBSCRIBE_NAMESPACE で空/ワイルドカード namespace 許可
  - FETCH レスポンスで不明な範囲を許可
  - REQUEST_UPDATE で Start Location 減少許可
  - 同一トラックで Datagram と Stream の混在許可
  - 未対応: SUBSCRIBE_NAMESPACE の専用ストリーム対応
  - 未対応: SUBSCRIBE_NAMESPACE の NAMESPACE/NAMESPACE_DONE 受信処理
  - 未対応: Subgroup 再オープン禁止
  - @voluntas
- [CHANGE] draft-ietf-moq-msf-00 に対応する
  - removeTracks の型を string[] から RemoveTrack[] ({name, namespace?}) に変更
  - CatalogDelta 型を新設し delta update が version/tracks を含まないようにする
  - cloneTracks で depends[0] ではなく parentName を使用する
  - EventTimelineEntry.data の型を Record<string, unknown> から unknown に変更
  - decodeCatalog を decodeCatalogMessage にリネーム
  - encodeCatalogDelta を追加
  - @voluntas
- [CHANGE] draft-ietf-moq-loc-02 に対応する
  - LOC Header Extensions を LOC Properties にリネーム
  - Timestamp / Timescale プロパティを追加
  - @voluntas
- [FIX] sendObject の並行呼び出し時にストリームの二重 close() が発生する問題を修正する
  - @voluntas

### misc

- [ADD] `pnpm run test:cov` でカバレッジ付きテストを実行できるようにする
  - @voluntas
- [UPDATE] Vite から Vite+ に切り替える
  - @voluntas
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
