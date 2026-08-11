# namespace ループが GOAWAY 受信後に送信方向を閉じない

- Created: 2026-08-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-namespace-goaway-send-direction-close
- Polished: {YYYY-MM-DD}

## 目的

namespace 系ストリーム (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / PUBLISH_NAMESPACE) で GOAWAY を受信した際、draft-ietf-moq-transport-19 §10.4 の SHOULD「close the old request stream using the appropriate mechanism (e.g. FIN, stream reset, or PUBLISH_DONE)」に従い、送信方向を FIN (writer.close()) で閉じる。

## 現状

- 0372 の実装で namespace 3 ループは GOAWAY 受信後も読み取りを継続する (重複 GOAWAY 検出のため)。しかし送信方向 (writer) は開いたままにする。
- ピアが FIN も GOING_AWAY リセットも送らない場合、namespaceSubscriptions / tracksSubscriptions / namespacePublications の Map エントリと streamReader ロックがセッション close まで残る。
- 一方、bidi の subscribe ロール (bidiReadRequestStreamMessages) は GOAWAY 受信時に `streamInfo.writer.close()` で送信方向を FIN する。namespace ループには同様の FIN 送信がない。
- 0372 の設計方針は「送信方向はアプリの再発行に委ね、受信方向の読み取りを継続する」としていたが、§10.4 SHOULD の観点で FIN 送信が望ましい。

## 設計方針

- namespace ループの GOAWAY 受信 (resolved=true) 時も、送信方向を `writer.close()` で FIN し、ピアの応答 (FIN) を促す。受信方向の読み取り継続は維持する。
- writer は namespaceSubscriptions / tracksSubscriptions / namespacePublications のエントリから取得する。

## 完了条件

- namespace ループで GOAWAY 受信時に送信方向が FIN (writer.close()) で閉じられること。
- 重複 GOAWAY 検出 (読み取り継続) が維持されること。
- テストがあること。

## 解決方法

未着手。
