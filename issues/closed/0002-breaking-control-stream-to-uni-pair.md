# 制御ストリームを双方向から単方向ペアに変更

## 概要

制御ストリームを双方向ストリーム 1 本から、単方向ストリーム 2 本のペアに変更する。

## 参照

- draft-ietf-moq-transport-17 Section 4
- https://github.com/moq-wg/moq-transport/pull/1510

## 変更内容

- draft-16 では制御ストリームは 1 本の双方向ストリーム (bidirectional stream) を使用していた
- draft-17 では送信用と受信用の単方向ストリーム (unidirectional stream) のペアに変更
- クライアントとサーバーがそれぞれ 1 本ずつ単方向ストリームを開く

## 影響範囲

- `src/controlStream.ts`
- `src/session.ts`

## 実装方針

1. draft-17 Section 4 の新しい制御ストリーム仕様を確認する
2. `src/controlStream.ts` を単方向ストリームペアに対応させる
3. `src/session.ts` のセッション確立フローを更新する
4. 制御ストリームの開設・読み書き処理を単方向ストリーム前提に変更する

## 解決方法

`session.ts` の `initialize()` を `createUnidirectionalStream()` と `incomingUnidirectionalStreams` を使用するよう変更した。`controlStream` (双方向) を `controlSendStream` (送信用単方向) と `controlReceiveStream` (受信用単方向) に分割。`sendControlMessage` と `startControlMessageLoop` も対応するストリームを使用するよう更新。`controlStream.ts` はストリーム種別に依存しないメッセージフレーミング実装のため変更不要。
