# 制御メッセージ長を varint にし MAX_CONTROL_MESSAGE_SIZE を交渉する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-control-message-framing
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-23 §9 / §9.1.8 は Message Length を 16 bit 固定長から vi64 に変更し、SETUP Option 0x09 の MAX_CONTROL_MESSAGE_SIZE を追加した。現在のフレーミングでは draft 23 のすべての制御メッセージを誤読する。

## 現状

- `src/controlStream.ts` の `ControlStreamReader.processMessages` は Type の後ろの 2 バイトを長さとして読む。`ControlStreamWriter.encode` も 2 バイトで書き、65535 バイト超を一律拒否する
- `src/message/types.ts` の `SetupOptionType`、`src/message/setup.ts`、`src/session/connection.ts` の `ConnectionInitializeOptions` に MAX_CONTROL_MESSAGE_SIZE が無い
- Session 制御ストリームに加え、`src/session/bidi.ts`、`namespaces.ts`、`incomingPublish.ts` がリクエストごとに reader / writer を作るため、上限の配線も全経路に必要になる

## 設計方針

- Type / Length の両方を既存の vi64 codec で読み書きする。Length の途中でチャンクが切れた場合は待機し、宣言長がローカル上限を超えた時点で FIELD_LENGTH_EXCEEDED にする。安全な数値への変換前に bigint で上限を比較する
- ローカル受信上限と peer 送信上限を別々に保持する。省略時と peer SETUP 受信前は 65535、広告値は最低 65535 とし、SETUP 自身にも初期上限を適用する
- Option 0x09 は Setup Option の KVP 規則に従って符号化し、値を vi64 として解釈する。公開接続設定から Session と全 reader / writer へ渡す
- 本文の Message Length と比較する。KVP の個別 Length 上限など、§8.3 が別に定める制限まで一括で緩めない
- 送信失敗時に pending やトークン予約を残さない。大きいメッセージを許す場合のバッファ上限と §15.5 のフロー制御上の条件も確認する

## 完了条件

- 1 / 2 / 3 / 4 / 5 / 9 バイトの Length、各バイトでのチャンク分割、連結メッセージを検証する
- 初期値 65535、交渉後の拡張、ローカルと peer の非対称な上限、上限超過、最低値違反をテストする
- SETUP、Session 制御、すべてのリクエストストリームで新形式と上限が一貫する
- `vp check` / `vp run typecheck` / `vp test run` が通る

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §9 / §9.1.8 / §15.5 / §16.4
- `src/controlStream.ts`、`src/message/setup.ts`、`src/session/connection.ts`、`src/session/publicTypes.ts`
- 0902 のセッションエラー分類と接続する

## 解決方法

{未着手}
