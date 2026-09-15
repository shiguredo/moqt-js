# MAX_REQUEST_UPDATES の受信側強制が無い

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-max-request-updates-receive
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §9.1.7 は、ある request stream 上で既に MAX_REQUEST_UPDATES 件の未応答 REQUEST_UPDATE がある状態でさらに受信した場合、TOO_MANY_REQUEST_UPDATES でセッションを閉じる MUST を定める。送信側の遵守は実装済みだが受信側の強制がなく、自分が広告した上限を超えてパイプラインされても通常どおり応答してしまう。

`ConnectOptions.maxRequestUpdates` で SETUP に広告できるようになったため、「広告しないので受信側制限は不要」という以前の前提は成立しなくなっている。

## 現状

- `ConnectOptions.maxRequestUpdates` (`src/session.ts`) は `createSetup` へ渡して SETUP に広告するだけで、ローカル上限として保持するフィールドがない
- 比較対象: `localMaxFilterRanges` と `localMaxAuthTokenCacheSize` は自 endpoint が広告した上限として保持し、受信検証に使っている
- `SessionErrorCode.TOO_MANY_REQUEST_UPDATES` (`src/error.ts`) は定義されているが送出箇所がない
- 受信 REQUEST_UPDATE の 2 経路 (受信 PUBLISH ストリームと送信 PUBLISH ストリーム) はいずれもストリーム単位の未応答数を数えていない
- 送信側は `bidiSendRequestUpdate` でピア上限を超える送信を拒否しており、送受信で非対称

draft-ietf-moq-transport-21 §9.1.7:

> If an endpoint receives a REQUEST_UPDATE on a stream that already has MAX_REQUEST_UPDATES outstanding REQUEST_UPDATEs, it MUST close the session with TOO_MANY_REQUEST_UPDATES.

## 設計方針

- 広告値の既定は 0 (無制限)。0 のときは強制しない
- 受信 REQUEST_UPDATE をストリーム単位の未応答集合へ追加し、追加前に件数が上限以上なら TOO_MANY_REQUEST_UPDATES で閉じる
- REQUEST_OK / REQUEST_ERROR の送信完了で集合から除く
- §9.5 が認める coalescing を併用してもよい。併用する場合は coalescing で一括応答するまで credit が戻らないことを仕様どおりに扱う

## 完了条件

- 上限 N (N>0) を広告した状態で、N 件の未応答があるストリームに REQUEST_UPDATE が届くと TOO_MANY_REQUEST_UPDATES で閉じる
- 未広告 (既定 0) では強制しない
- REQUEST_OK / REQUEST_ERROR の応答で credit が戻る
- 受信 REQUEST_UPDATE の 2 経路の双方で機能する
- テストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES)
- draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE)
- draft-ietf-moq-transport-21 §12.2 (Session Termination Codes)
