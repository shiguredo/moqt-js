# アイドル接続処理の説明

## 概要

アイドル接続のハンドリングに関する説明を追加する。

## 参照

- draft-ietf-moq-transport-17 Section 4
- https://github.com/moq-wg/moq-transport/pull/1443

## 変更内容

- draft-17 でアイドル状態の接続をどのように処理すべきかの説明が追加された
- QUIC のアイドルタイムアウトとの関連性が明確化された

## 影響範囲

- `src/session.ts`

## 実装方針

1. draft-17 Section 4 のアイドル接続処理を確認する
2. アイドル接続の検出とハンドリングを実装する
3. QUIC のアイドルタイムアウトとの連携を確認する

## 解決方法

draft-17 Section 12.2.1 のアイドル接続処理は editorial な変更であり、実装の選択肢（QUIC PING、定期的な制御メッセージ、再接続ロジック）を説明するもの。moqt-js ではアイドルタイムアウトは WebTransport レイヤーで処理されるため、ライブラリ側のコード変更は不要。
