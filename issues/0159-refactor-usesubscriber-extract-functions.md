# `useSubscriber.ts` を関数抽出して責務を分割する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts` は 740 行を超え、`startSubscribing` 単体で 445 行という巨大関数になっている。`connectOptions` 構築・`connect`・Catalog 購読 (Promise.race + timeout)・デコーダ初期化・`subscribeOptions` 構築・`session.subscribe`・3 度の中断チェック・エラーパスがすべて 1 つの try に詰め込まれており、CLAUDE.md「一切妥協をしないこと」の観点で未達。

## 根拠

- ファイル全長 740 行
- `startSubscribing` (178-622 行) 内に 2 つの巨大 IIFE (`catalogPromise` 構築 244-320 行 / `joiningFetch onObject/onEnd/onError` 431-566 行)
- 共通の build 系処理 (`connectOptions`, `subscribeOptions`) がスコープ外に切り出せていないため、テスト不能
- CLAUDE.md「変数名を省略しないこと」「コメントは必要最小限」「一切妥協をしないこと」

## 修正方針

以下の関数群を `useSubscriber.ts` のフックスコープ外 (モジュールスコープ) または別ファイルへ抽出する。pure に書ければ単体テストも容易になる (issue #0160 と連動)。

1. **`buildConnectOptions(settings)`** (現 191-206 行): 戻り値型は `{ serverCertificateHashes?: CertificateHash[]; authorizationToken?: AuthorizationToken }`。`settings` をフック側で `import * as settings` していたものを引数で渡すか、`signals/connectionSettings.ts` 側に置く

2. **`subscribeCatalog(session, namespaceArray, catalogTimeout, instance, addLog, subscriberId): Promise<CatalogTrack>`** (現 243-347 行): Promise.race + timeout を含む。返り値は `videoTrackFromCatalog`。`actualTrackName` も返す形に整理する

3. **`createDecoder(track, useWorker, onOutput, onError): DecoderWrapper`** (現 354-389 行): VideoDecoderConfig 構築と `DecoderWrapper` インスタンス生成

4. **`buildJoiningFetchOptions(instance, handleObject): JoiningFetchOptions`** (現 431-566 行): onObject / onEnd / onError コールバック群

5. **`resetStats(instance)`** (現 411-428 行): 統計フィールドの 0 リセット

`startSubscribing` 本体は 50 行以内を目標にする。

## 抽出方針の例

`useSubscriber.ts` のフッククロージャに依存している箇所 (例: `chainRef`, `canvasRef`, `subscriberId`) はクロージャを保ったまま、純粋に extracable な処理から先に切り出す。

- `buildConnectOptions` は依存なし → 完全 pure に切り出し可能 (signals/connectionSettings.ts へ移動)
- `createDecoder` は `subscriberId` / `instance` への参照を引数で渡せば pure 化可能
- `buildJoiningFetchOptions` は `handleObject` / `instance` / `subscriberId` を引数で受ければ pure 化可能
- `subscribeCatalog` は `session` / `namespaceArray` / `catalogTimeout` / `instance` / `addLog` / `subscriberId` を引数で受ければ pure 化可能

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts`
- 可能なら `devtools/src/signals/connectionSettings.ts` (buildConnectOptions の移動先)
- 可能なら `devtools/src/hooks/subscribeCatalog.ts` 等の新規ファイル (関数抽出先)

## テスト戦略

- `vp run build:devtools` でビルドが通ることを確認する
- `vp run test` で全 456 テストがパスすることを確認する
- issue #0160 で追加するテストにて、抽出した pure 関数 (`buildConnectOptions`, `resetStats`, `buildJoiningFetchOptions` のコールバック挙動) を単体テストする

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (内部 API の責務分割。挙動変更なし)

## 完了条件

- `useSubscriber.ts` の `startSubscribing` 本体が 100 行以内に収まる
- 上記 5 関数のうち最低 3 つが抽出されている
- `vp run build:devtools` が成功する
- `vp run test` が全テストパスする
