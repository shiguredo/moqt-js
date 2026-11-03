# connectMediaSession の GOAWAY の橋渡しをテストできるようにする

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/test-connect-media-goaway-bridge
- Polished: {YYYY-MM-DD}

## 目的

`src/createMedia/connect.ts` の `connectMediaSession` は `ConnectCallbacks.goaway` から `MediaConnectSettings.onSessionGoaway` へ新しい Session URI を渡す。この 1 行が高レベル API の制御ストリーム由来の `onGoaway` の唯一の入口だが、高レベルのテストは `openSession` を差し替えて `settings.onSessionGoaway` を直接呼ぶため、この行はどのテストでも駆動されない。0891 の変異実験では、この行を削除しても全テストが通った。将来のリファクタで無音に壊れるリスクを解消する。

## 現状

- `connectMediaSession` は `connect(settings.url, connectCallbacks, connectOptions)` を呼び、`connectCallbacks` に `goaway: (newSessionUri) => settings.onSessionGoaway(newSessionUri)` を渡す
- `src/createMediaPublisher.ts` と `src/createMediaSubscriber.ts` の `openSession` が `connectMediaSession` を呼ぶ
- 高レベルのテストハーネスは `control.openSession` を置き換え、`settings.onSessionGoaway` を直接呼ぶ
- 低レベルの `sessionHandleGoaway` は `callbacks.goaway` を呼ぶ

## 設計方針

`connectMediaSession` から WebTransport を要する接続を注入できるようにし、`ConnectCallbacks.goaway` が `onSessionGoaway` に URI を渡すことを直接テストする。

- 案 A: `connectMediaSession` に `connectSession` (接続関数) を注入する引数を足し、テストで差し替える。`connect.ts` の橋渡しだけを駆動できる
- 案 B: `ConnectCallbacks` の組み立てを `buildConnectCallbacks(settings)` のような純関数に切り出し、`goaway` が `settings.onSessionGoaway` を呼ぶことを単体テストで固定する。接続は駆動しないが、変異検出はできる

公開 API を変えない案 B を優先する。`connectMediaSession` の JSDoc に、この分離の意図を書く。

## 完了条件

- `ConnectCallbacks.goaway` から `MediaConnectSettings.onSessionGoaway` への橋渡しがテストで固定される
- 橋渡しを削除するとテストが落ちる (変異検出できる)
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。テストのみの変更のため `### misc` にも記載しない。

## 参照

- `src/createMedia/connect.ts` の `connectMediaSession` / `MediaConnectSettings`
- `src/createMediaPublisher.ts` / `src/createMediaSubscriber.ts` の `openSession` / `connectToServer`
- `src/session/publicTypes.ts` の `ConnectCallbacks.goaway`
- `issues/closed/0891-add-high-level-goaway-migration.md` の解決方法 (橋渡しが変異検出できない旨)
