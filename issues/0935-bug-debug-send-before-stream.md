# PUBLISH_NAMESPACE の debug の send イベントがストリーム作成前に出る

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-debug-send-before-stream
- Polished: {YYYY-MM-DD}

## 目的

`Session.publishNamespace()` は `PUBLISH_NAMESPACE` の debug イベントを、双方向ストリームの作成と reader / writer の取得より前に出している。ストリームの作成や取得が失敗した場合も `direction: "send"` のイベントが出るため、実際には transport に渡っていないメッセージが「送信した」ように見える。既存の `publish()` / `subscribe()` / `subscribeNamespace()` / `subscribeTracks()` はストリームを作成してから debug を出しており、非対称である。

## 現状

- `src/session/namespaces.ts` の `namespacesPublishNamespace` は、パラメータ構築・encode・debug コールバックをすべて送信 (detached な `namespacesSendPublishNamespace`) より前に行う
- `namespacesPublishNamespace` の debug イベントは `createBidirectionalStream` の前になる
- `namespacesSubscribeNamespace` / `namespacesSubscribeTracks` と `src/session/requests.ts` の publish / subscribe は、ストリーム作成後に debug を出してから write する
- `docs/LOW_LEVEL_API.md` の `ConnectCallbacks.debug` は「送受信した MOQT メッセージの raw 情報」と説明している
- 0890 で送信を detached にした際、debug を送信前 (Promise 作成前) に置いた。debug の throw を送信前失敗として扱うための判断だったが、この理由はコメントに無い

## 設計方針

debug の send イベントを、送信処理のストリーム作成・reader / writer 取得の後、`writer.write` の前へ移す。

- イベントの payload と decoded はリクエストに載せて送信処理へ渡す
- debug が throw した場合は送信の catch でストリームを解放し、元のエラーで reject する
- この変更で「送信前の throw ではストリームを作らない」テストは、debug 以外の throw (encode など) で固定する形に更新する
- 代替として debug を「送信試行」と定義して docs に明記する案もあるが、既存 3 経路との一貫性を優先して位置を揃える

## 完了条件

- ストリーム作成前の失敗では debug の send イベントが出ない
- debug の throw ではストリームを解放し、元のエラーで reject する
- 送信成功時の debug イベントの内容 (payload / decoded) は変わらない
- docs と JSDoc を実装に合わせる
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesSendPublishNamespace` / `namespacesSubscribeNamespace` / `namespacesSubscribeTracks`
- `src/session/requests.ts` の publish / subscribe の debug 呼び出し
- `src/session/bidi.ts` の debug 呼び出し
- `src/session/publicTypes.ts` の `ConnectCallbacks.debug`
- `docs/LOW_LEVEL_API.md` の `ConnectCallbacks`
