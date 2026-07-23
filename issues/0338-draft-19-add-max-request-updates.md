# MAX_REQUEST_UPDATES Setup Option と TOO_MANY_REQUEST_UPDATES エラーコードを追加する (draft-19 追従)

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/add-draft-19-max-request-updates
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 10.3.1.7 で MAX_REQUEST_UPDATES Setup Option (Option Type 0x08) と、セッション終了エラーコード TOO_MANY_REQUEST_UPDATES (0x1B) が新設された (draft-18 → 19 変更履歴 "Add MAX_REQUEST_UPDATES Setup Option and TOO_MANY_REQUEST_UPDATES error (#1613)")。

draft-19 Section 10.3.1.7:

> The MAX_REQUEST_UPDATES option (Option Type 0x08) communicates the
> maximum number of unacknowledged REQUEST_UPDATE messages per request
> stream that the endpoint is willing to receive.
>
> The sender MUST NOT have more than MAX_REQUEST_UPDATES
> outstanding REQUEST_UPDATEs on any single request stream at a time.
>
> A value of 0 means the endpoint does not limit REQUEST_UPDATE
> concurrency. If not present, the default value is 0.
>
> If an endpoint receives a REQUEST_UPDATE on a stream that already has
> MAX_REQUEST_UPDATES outstanding REQUEST_UPDATEs, it MUST close the
> session with TOO_MANY_REQUEST_UPDATES.

REQUEST_UPDATE は「送信してから対応する REQUEST_OK / REQUEST_ERROR を受信するまで」outstanding として数える。draft-18 には 0x08 の Setup Option もエラーコード 0x1B も存在しない。

## 優先度根拠

moqt-js が REQUEST_UPDATE 送信側としてピアの MAX_REQUEST_UPDATES を尊重しないと、上限を広告する draft-19 準拠ピアに TOO_MANY_REQUEST_UPDATES でセッションを切断され得る。`update()` を多用するアプリケーションで顕在化するため Medium。

## 現状

- `src/message/types.ts:83-96`: `SetupOptionType` に 0x08 (MAX_REQUEST_UPDATES) が未定義
- `src/message/setup.ts:42-78`: `createSetup` が送出するのは AUTHORIZATION_TOKEN (0x03) と MAX_AUTH_TOKEN_CACHE_SIZE (0x04) と MOQT_IMPLEMENTATION (0x07) のみ。未知オプションは受信時に無視される (`src/message/setup.ts:89-95`) ため受信で壊れはしない
- `src/error.ts:17-38`: `SessionErrorCode` は MALFORMED_AUTHORITY (0x1a) まで。TOO_MANY_REQUEST_UPDATES (0x1b) が未定義で、受信時に正しく識別できない
- REQUEST_UPDATE 送信経路: `src/subscriber.ts:259-267` `update()` → `src/session.ts:3344-3348` `sendRequestUpdate` → `src/session/bidi.ts:843-891` `bidiSendRequestUpdate`。outstanding 数の管理・制限なし

## 設計方針

- `SetupOptionType.MAX_REQUEST_UPDATES = 0x08` を追加し、受信した SETUP からピアの値を取得・保持する getter を `src/message/setup.ts` に追加する
- 送信側: リクエストストリームごとの outstanding REQUEST_UPDATE 数を管理し、ピアの上限に達している間は送信をエラーにする (0 = 無制限)
- `SessionErrorCode.TOO_MANY_REQUEST_UPDATES = 0x1b` を追加する
- 受信側: 自側の上限を広告する場合は、超過受信時に TOO_MANY_REQUEST_UPDATES でセッションを閉じる。自側上限の広告 API (initialize オプション) を追加するかは設計時に判断する (広告しない場合、デフォルト 0 = 無制限のため受信側制限の実装は不要)
- 仕様参照コメントは draft-19 Section 10.3.1.7 を引用する

## 完了条件

- ピアが MAX_REQUEST_UPDATES を広告した場合、上限を超える REQUEST_UPDATE を送信しないこと (テストで確認)
- `SessionErrorCode.TOO_MANY_REQUEST_UPDATES` が定義され、受信時に正しいエラー名で扱われること
- lint / build / typecheck / 既存テストが通ること
