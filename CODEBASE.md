# CODEBASE

- **現時点ではブラウザでの利用のみを想定しているため、クライアントでのみ利用すること** (MOQT の publisher / subscriber として接続する用途だけを対象とする)
- **クライアント以外での用途の実装は不要であること** (サーバー / リレーとしての動作は実装しない)
  - Relay 間の相互接続 (relay to relay) は draft-ietf-moq-transport-22 §7 (Relays) が、coordinated set of relays を単一の MOQT relay として扱い「How relays within such a set interconnect, and use cases built on relay to relay communication, are out of scope.」と定めているため、本仕様の対象外として実装しない
- **Node.js が WebTransport に正式対応したら、テスト用としてサーバー対応も行うこと**
- より良い設計のためには破壊的変更を恐れないこと
- 最新ドラフトに準拠すること
- **`sora-moq` について書いてよいのは「Sora の Media over QUIC 実装であり、リレー機能を提供する」ということだけである**

## 表示

- 音声と映像を並べるときは audio → video の順にすること (統計も表示も)
- 数値の単位 (dBFS / dBov / ms など) は、値が変わっても位置が動かないように固定すること
  - 単位が動くと値の変化を読み取れず、非常に見づらくなる
  - 数値を空白で埋めて桁を揃える場合、HTML では空白が潰れないようにすること (`whitespace-pre` など)

## i18n

- devtools の UI は英語表記
