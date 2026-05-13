# REQUEST_ERROR と確立済み subscription に REDIRECT を追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で REQUEST_ERROR に Redirect Structure が追加され、
さらに確立済みの subscription / publish に対しても REDIRECT 経由でリダイレクト指示を出せるようになった。
クライアントは REDIRECT を受信した場合、指示された URI へ接続を張り直すなどの処理が必要となる。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.6 REQUEST_ERROR
- draft-ietf-moq-transport-18 §10.6.1 Redirect Structure
- draft-ietf-moq-transport-18 §10.6.2 REQUEST_ERROR Message Format
- moq-wg/moq-transport#1534

## 影響範囲

- REQUEST_ERROR のデコード処理
- リダイレクト受信時の Subscriber / Publisher の挙動
- アプリケーションへのリダイレクト通知 API
