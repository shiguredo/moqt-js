# MAX_REQUEST_UPDATES Setup Option と TOO_MANY_REQUEST_UPDATES を追加する (draft-19 追従)

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/add-draft-19-max-request-updates
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 で MAX_REQUEST_UPDATES Setup Option と TOO_MANY_REQUEST_UPDATES エラーコードが新設された。変更履歴は Appendix A.1 `#1613`。

- Setup Option: Section 10.3.1.7 (MAX_REQUEST_UPDATES)、Option Type `0x08`
- セッション終了エラー: Section 3.5、`TOO_MANY_REQUEST_UPDATES (0x1B)`

draft-19 Section 10.3.1.7:

> The MAX_REQUEST_UPDATES option (Option Type 0x08) communicates the
> maximum number of unacknowledged REQUEST_UPDATE messages per request
> stream that the endpoint is willing to receive.
>
> A REQUEST_UPDATE is considered outstanding from when it is sent until
> the sender receives the corresponding REQUEST_OK or REQUEST_ERROR
> response. The sender MUST NOT have more than MAX_REQUEST_UPDATES
> outstanding REQUEST_UPDATEs on any single request stream at a time.
> ...
> The value is encoded as a variable-length integer. A value of 0
> means the endpoint does not limit REQUEST_UPDATE concurrency. If not
> present, the default value is 0.
>
> If an endpoint receives a REQUEST_UPDATE on a stream that already has
> MAX_REQUEST_UPDATES outstanding REQUEST_UPDATEs, it MUST close the
> session with TOO_MANY_REQUEST_UPDATES.

draft-19 Section 3.5:

> TOO_MANY_REQUEST_UPDATES (0x1B): The endpoint received a
> REQUEST_UPDATE that exceeded the per-stream limit communicated via
> the MAX_REQUEST_UPDATES Setup Option (Section 10.3.1.7).

## 優先度根拠

moqt-js が REQUEST_UPDATE 送信側としてピアの MAX_REQUEST_UPDATES を尊重しないと、上限を広告する draft-19 準拠ピアに TOO_MANY_REQUEST_UPDATES でセッションを切断され得る。`update()` を多用するアプリケーションで顕在化するため Medium。

## 現状

- `src/message/types.ts`: `SetupOptionType` に `0x08` (MAX_REQUEST_UPDATES) が未定義
- `src/message/setup.ts`: `createSetup` が送出するのは AUTHORIZATION_TOKEN / MAX_AUTH_TOKEN_CACHE_SIZE / MOQT_IMPLEMENTATION のみ。未知オプションは受信時に無視されるため、受信だけでは直ちに壊れない
- `src/error.ts`: `SessionErrorCode` は MALFORMED_AUTHORITY (0x1a) まで。TOO_MANY_REQUEST_UPDATES (0x1b) が未定義
- REQUEST_UPDATE 送信経路に outstanding 数の管理・制限がない

## 設計方針

- `SetupOptionType.MAX_REQUEST_UPDATES = 0x08` を追加し、受信した SETUP からピアの値を取得・保持する getter を追加する
- 送信側: リクエストストリームごとの outstanding REQUEST_UPDATE 数を管理し、ピアの上限に達している間は送信をエラーにする (0 = 無制限、Section 10.3.1.7)
- `SessionErrorCode.TOO_MANY_REQUEST_UPDATES = 0x1b` を追加する (Section 3.5)
- 受信側: 自側の上限を広告する場合は、超過受信時に TOO_MANY_REQUEST_UPDATES でセッションを閉じる。自側上限の広告 API (initialize オプション) を追加するかは設計時に判断する (広告しない場合、デフォルト 0 = 無制限のため受信側制限の実装は不要)
- 仕様参照コメントは Section 10.3.1.7 と Section 3.5 を分けて引用する

## 完了条件

- ピアが MAX_REQUEST_UPDATES を広告した場合、上限を超える REQUEST_UPDATE を送信しないこと (テストで確認)
- `SessionErrorCode.TOO_MANY_REQUEST_UPDATES` が定義され、受信時に正しいエラー名で扱われること
- lint / build / typecheck / 既存テストが通ること
