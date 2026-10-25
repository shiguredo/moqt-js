# 高レベル API から接続のタイムアウトと受信バッファ上限を指定できない

- Created: 2026-10-25
- Completed: {YYYY-MM-DD}
- Branch: feature/add-high-level-connect-options
- Polished: {YYYY-MM-DD}

## 目的

`createMediaPublisher` / `createMediaSubscriber` の利用者は、低レベル `connect()` の `ConnectOptions.controlMessageTimeoutMs` / `dataStreamTimeoutMs` / `dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes` を指定できない。高レベル API の `MediaPublisherOptions` / `MediaSubscriberOptions` は `serverCertificateHashes` / `authorizationToken` / `pendingSubgroup` だけを `MediaConnectSettings` へ渡しており、タイムアウトと受信バッファ上限は既定値のままになる。高レベル API からも同じ 4 フィールドを指定できるようにする。

## 現状

- `src/codec/types.ts` の `MediaPublisherOptions` と `MediaSubscriberOptions` は `serverCertificateHashes` / `authorizationToken` / `pendingSubgroup` を持つが、`controlMessageTimeoutMs` / `dataStreamTimeoutMs` / `dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes` を持たない
- `src/createMediaPublisher.ts` の `connectToServer` と `src/createMediaSubscriber.ts` の `connectToServer` は、上記 3 フィールドだけを `MediaConnectSettings` へ渡す
- `src/createMedia/connect.ts` の `MediaConnectSettings` は `url` / `serverCertificateHashes` / `authorizationToken` / `pendingSubgroup` と `onSessionClose` / `onSessionError` を持ち、`connectMediaSession` は `serverCertificateHashes` / `authorizationToken` / `pendingSubgroup` の 3 フィールドだけを `ConnectOptions` へ写す
- `ConnectOptions` は上記 4 フィールドを持ち、`connect()` はそれらを `session.initialize` へ渡す。低レベル API では指定できる
- `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions` / `MediaSubscriberOptions` の表にも 4 フィールドが無い
- `CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)

## 設計方針

- `MediaPublisherOptions` と `MediaSubscriberOptions` に `controlMessageTimeoutMs` / `dataStreamTimeoutMs` / `dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes` を optional で追加する。型は `ConnectOptions` の同名フィールドと同じ `number` とする
- `MediaConnectSettings` に同じ 4 フィールドを optional で追加する
- `createMediaPublisher` / `createMediaSubscriber` の `connectToServer` で、定義済みのフィールドだけを `MediaConnectSettings` へ渡す (`exactOptionalPropertyTypes` のため undefined を渡さない)
- `connectMediaSession` で、定義済みのフィールドだけを `ConnectOptions` へ渡す
- `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions` / `MediaSubscriberOptions` の表に 4 フィールドと既定値を追記する。既定値は `ConnectOptions` と同じ (control 10,000 ms / data 30,000 ms / 32 MiB / 64 MiB) であり、0 以下で上限なし・タイムアウトなし
- テストは `src/createMedia/connect.test.ts` を新設し、`connectMediaSession` の `ConnectOptions` の組み立てを純粋関数 `connectBuildConnectOptions` として切り出して固定する。0688 が同じ関数を切り出す場合は、その関数に 4 フィールドを足してテストを拡張する。0688 が未実装なら本 issue で同じ切り出しを行う。`MediaPublisherOptions` / `MediaSubscriberOptions` から `MediaConnectSettings` への写しは、`createMediaPublisher` / `createMediaSubscriber` の `openSession` を差し替える既存テストで固定する
- 公開 API の追加であり、利用者から見た既定値は変わらない。`CHANGES.md` は CODEBASE.md の特別ルールに従い更新しない

## 完了条件

- `MediaPublisherOptions` / `MediaSubscriberOptions` から 4 フィールドを指定できる
- 指定した 4 フィールドが `MediaConnectSettings` と `ConnectOptions` を経由して `session.initialize` へ渡る
- 未指定のフィールドは `ConnectOptions` に載らず、既定値が使われる
- `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions` / `MediaSubscriberOptions` の表に 4 フィールドと既定値が載っている
- `src/createMedia/connect.test.ts` と既存の `openSession` 差し替えテストで、4 フィールドの写しと未指定時の除外が固定されている
- `npx vp check` / `npx vp test --run` が通る

## 参照

- `ConnectOptions` (`src/session/publicTypes.ts`) と `ConnectionInitializeOptions` (`src/session/connection.ts`)
- `src/codec/types.ts` の `MediaPublisherOptions` / `MediaSubscriberOptions`
- `src/createMedia/connect.ts` の `MediaConnectSettings` / `connectMediaSession`
- `src/createMediaPublisher.ts` / `src/createMediaSubscriber.ts` の `connectToServer`
- `docs/HIGH_LEVEL_API.md` の `MediaPublisherOptions` / `MediaSubscriberOptions`
- 0688 (`connectBuildConnectOptions` の切り出しを含む。本 issue は同じ関数に 4 フィールドを追加する。0688 が未実装なら本 issue で切り出す)
- `CODEBASE.md` (MOQT RFC ドラフト中のため `CHANGES.md` を更新しない)

## 解決方法

{未着手}
