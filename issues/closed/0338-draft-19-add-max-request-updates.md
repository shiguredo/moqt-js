# MAX_REQUEST_UPDATES Setup Option と TOO_MANY_REQUEST_UPDATES を追加する (draft-19 追従)

- Priority: Medium
- Created: 2026-07-07
- Completed: 2026-07-24
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
> Each REQUEST_OK or REQUEST_ERROR response restores one credit on that
> stream. ...
> The value is encoded as a variable-length integer. A value of 0
> means the endpoint does not limit REQUEST_UPDATE concurrency. If not
> present, the default value is 0.
>
> If an endpoint receives a REQUEST_UPDATE on a stream that already has
> MAX_REQUEST_UPDATES outstanding REQUEST_UPDATEs, it MUST close the
> session with TOO_MANY_REQUEST_UPDATES.

**outstanding の定義（本 issue の用語）**: ある request stream 上で、送信済みかつ対応する REQUEST_OK / REQUEST_ERROR をまだ受信していない REQUEST_UPDATE の件数。応答を 1 つ受けるごとにそのストリームの credit が 1 戻る。上限は **リクエストストリームごと**（セッション全体ではない）。

draft-19 Section 3.5:

> TOO_MANY_REQUEST_UPDATES (0x1B): The endpoint received a
> REQUEST_UPDATE that exceeded the per-stream limit communicated via
> the MAX_REQUEST_UPDATES Setup Option (Section 10.3.1.7).

送信側の違反予防はローカルで送信を拒否する（MUST NOT）。受信側が広告した上限を超えて REQUEST_UPDATE を受けたときのセッション終了コードは `TOO_MANY_REQUEST_UPDATES` であり、`PROTOCOL_VIOLATION` ではない。

## 優先度根拠

moqt-js が REQUEST_UPDATE 送信側としてピアの MAX_REQUEST_UPDATES を尊重しないと、上限を広告する draft-19 準拠ピアに TOO_MANY_REQUEST_UPDATES でセッションを切断され得る。`Subscriber.update()` を多用するアプリケーションで顕在化するため Medium。

## 現状

シンボル名を正とする。

- `SetupOptionType`（`src/message/types.ts`）: `MOQT_IMPLEMENTATION: 0x07` まで。`0x08`（MAX_REQUEST_UPDATES）は未定義。`0x06` は `#0341` の MAX_FILTER_RANGES 用
- `createSetup`（`src/message/setup.ts`）: 送出は AUTHORIZATION_TOKEN / MAX_AUTH_TOKEN_CACHE_SIZE / MOQT_IMPLEMENTATION のみ。未知 Setup Option は受信時に無視（Section 10.3）
- `getSetupMaxAuthTokenCacheSize`: ピア値をデコードする getter はあるが、`session.ts` では SETUP 受信時にローカル変数へ取るだけで **Session フィールドとして保持していない**（debug 出力のみ）。MAX_REQUEST_UPDATES は送信ガードに使うため **Session に保持が必須**（MAX_AUTH と同型では足りない）
- `SessionErrorCode`（`src/error.ts`）: `MALFORMED_AUTHORITY (0x1a)` まで。`TOO_MANY_REQUEST_UPDATES (0x1b)` 未定義。`normalizeSessionErrorCode` は未知を INTERNAL_ERROR に落とす
- `pendingRequestUpdate`（`session.ts` / `bidi.ts`）: updateRequestId → `{ resolve, reject, targetRequestId }`。ストリームごとの outstanding 数チェックは無い。`bidiSendRequestUpdate` は上限を見ずに送信する

## 設計方針

### 本 issue の範囲（送信側ガード + 型定義）

1. `SetupOptionType.MAX_REQUEST_UPDATES = 0x08` と `getSetupMaxRequestUpdates(msg): number`（欠落時デフォルト 0）を追加する
2. SETUP 受信後、ピア値を `Session` のフィールド（例: `peerMaxRequestUpdates`、初期値 0）に保持し、`BidiSessionInternal`（`src/session/bidi.ts`）にも `readonly peerMaxRequestUpdates: number` を追加して `bidiSendRequestUpdate` から参照できるようにする。0 = 無制限。MAX_AUTH の「ローカル変数のみ」パターンは踏襲しない
3. `bidiSendRequestUpdate` で、`nextRequestId` 消費・pending 追加の **前** に、当該 `targetRequestId` の outstanding 件数（既存 `pendingRequestUpdate` を `targetRequestId` で数える）がピア上限以上（`count >= peerMax && peerMax > 0`）なら **throw `Error`**（セッションは閉じない — 送信 MUST NOT の予防）。ピア上限 0 のときはチェックしない
4. outstanding の増減タイミングは現行どおり（pending は送信前に追加、REQUEST_OK / REQUEST_ERROR で削除）。本 issue では追加タイミングを変えない。失敗 coalescing で複数 pending を一括 reject する変更は `#0337`。本 issue の件数ガードは `#0337` 後でも `pendingRequestUpdate` の件数を見るだけで整合する
5. `SessionErrorCode.TOO_MANY_REQUEST_UPDATES = 0x1b` を追加し、`normalizeSessionErrorCode` / テストに載せる（ピアがこのコードで閉じてきたとき正しく名前が付く）

### 意図的に含めないもの（MVP）

- **自側上限の SETUP 広告**と、受信側の outstanding カウント + `TOO_MANY_REQUEST_UPDATES` でのセッション切断。広告しない（デフォルト 0）ため受信側制限の実装は不要。広告 API が必要になったら別 issue
- `#0337` の unexpected REQUEST_UPDATE → PROTOCOL_VIOLATION、および pending 全 reject
- `#0341` の MAX_FILTER_RANGES（`0x06`）
- `#0339` の Graceful Closure

### テスト戦略（モック禁止）

- `getSetupMaxRequestUpdates`: 欠落 → 0、明示値のラウンドトリップ（`setup.test.ts`）
- `SessionErrorCode.TOO_MANY_REQUEST_UPDATES === 0x1b` と `normalizeSessionErrorCode(0x1b)`（`error.test.ts`）
- outstanding ガード: `pendingRequestUpdate` を実 Map で組み立て、ピア上限 N のとき N 件 pending がある `targetRequestId` への追加送信が throw し、N-1 なら通る、上限 0 なら常に通る。WebTransport モックは使わず、`bidiSendRequestUpdate` を呼ぶ前段の判定関数を切り出してテストするか、部分 session + 実 WritableStream で送信用 writer だけ用意する

## 完了条件

- ピアが MAX_REQUEST_UPDATES = N（N > 0）を広告した場合、同一 request stream で outstanding が N の間は新たな REQUEST_UPDATE を送信しない（throw）こと。テストあり
- ピア値が 0 または欠落のとき送信を制限しないこと
- `SessionErrorCode.TOO_MANY_REQUEST_UPDATES === 0x1b` が定義され、正規化で通ること
- 自側 SETUP に MAX_REQUEST_UPDATES を広告しないこと（本 MVP）
- `CHANGES.md` の `## develop` にエントリがあること
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. `src/message/types.ts`: `SetupOptionType.MAX_REQUEST_UPDATES = 0x08`
2. `src/message/setup.ts`: `getSetupMaxRequestUpdates` 追加（デフォルト 0）。`createSetup` への送出オプションは本 MVP では追加しない
3. `src/session.ts`: SETUP 受信でピア値をフィールドに保持。`BidiSessionInternal` にも同名を露出
4. `src/session/bidi.ts`: `BidiSessionInternal` に `peerMaxRequestUpdates` を追加。`bidiSendRequestUpdate` で pending 追加前に outstanding とピア上限を比較し、超過なら `throw new Error(...)`
5. `src/error.ts`: `TOO_MANY_REQUEST_UPDATES: 0x1b`
6. テスト: `setup.test.ts` / `error.test.ts` / outstanding ガードの単体。モック禁止
7. `CHANGES.md` の `## develop` に `[ADD]` で追記する
