# 制御メッセージ長を varint にし MAX_CONTROL_MESSAGE_SIZE を交渉する

- Created: 2026-11-03
- Completed: 2026-11-03
- Branch: feature/change-control-message-framing
- Polished: 2026-11-03

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

- `ControlStreamReader` / `ControlStreamWriter` を Type (vi64) + Message Length (vi64) + Message Body のフレーミングに変更した。Message Length は本文長で、受信側は宣言長を bigint で比較してから本文を読む。1 / 2 / 3 / 4 / 5 / 9 バイトの Length、チャンク分割、連結メッセージ、非最小 varint を検証するテストと PBT を追加した。
- SETUP Option 0x09 `MAX_CONTROL_MESSAGE_SIZE` を追加し、`createSetup` の `maxControlMessageSize` で広告、`getSetupMaxControlMessageSize` でピア広告値を取り出して送信上限に設定するようにした。省略時と最小値は 65535、SETUP 自身の送信にも既定値 65535 を適用する。SETUP の値が vi64 として不正、または 65535 未満の場合は MALFORMED_KEY_VALUE (0x6、現行の `KEY_VALUE_FORMATTING_ERROR`) として扱う。
- `ConnectOptions.maxControlMessageSize` を追加し、`connect()` では WebTransport を生成する前に値を検証する。ローカル受信上限とピア送信上限を `localMaxControlMessageSize` / `peerMaxControlMessageSize` に分けて保持し、制御ストリームと全リクエストストリームの reader / writer へ配線した。`initialize()` 失敗時に WebTransport を閉じる後始末も追加した。
- 受信した Message Length がローカル上限を超えた場合は `FIELD_LENGTH_EXCEEDED` (0x401) でセッションを閉じる。エラー終了は `sessionHandleFieldLengthExceeded` に集約し、閉鎖済みのセッションでの error コールバック二重通知を防ぐ。
- 送信する Message Length がピア上限を超える場合は、双方向ストリームを開く前にフレーミングで失敗させ、pending・トークン予約・fill の関連付けを残さないようにした。SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / REQUEST_UPDATE の各経路で検証する。
- draft-23 §9.19 に合わせ、Message Parameter の個別 Value 長上限を撤廃して制御メッセージ全体長のみの制限とした。§8.3 の KVP (Setup Option / Property) の 2^16-1 上限は受信側・送信側の両方で維持し、Property / Immutable Properties / LOC Config の単体エンコーダにも送信前検査を追加した。
- `docs/LOW_LEVEL_API.md` の `ConnectOptions` 表に `maxControlMessageSize` を追加し、既存の誤り (MOQT_IMPLEMENTATION の Option 番号) も修正した。制御メッセージ形式図の `Length (16)` / `Type (i)` を vi64 に追従させた。
- CHANGES.md は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」により更新しない。

### 残課題 (別 issue で扱う)

- `ControlStreamReader.feed` の逐次 concat が O(n²) である点
- 交渉後の大きな上限で 65535 バイト超の制御メッセージを Session 経由で受理する end-to-end テスト
- namespaces 系 3 経路の reader / writer 上限配線テスト
- KVP 長超過時のエラーコードを FIELD_LENGTH_EXCEEDED へ移行する作業 (セッションエラー分類の移行)
