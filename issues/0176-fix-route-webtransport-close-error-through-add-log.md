# WebTransport `close` / `error` と Catalog ライフサイクルログを `addLog` 経由で DebugPanel に流す

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts` と `devtools/src/hooks/usePublisher.ts` の `connect(...)` 第 2 引数で渡している `close` / `error` コールバックは `console.log` / `console.error` でしか出力されておらず、`DebugPanel` のログ一覧には流れない。一方、同じファイル内の `handleDebugMessage` は `addLog("info", ...)` 経由で DebugPanel に流れる。

DebugPanel は「MOQT 内部の挙動と接続イベントをユーザーに可視化するための唯一の経路」として位置づけられているため、WebTransport セッションの `close` / `error` が DebugPanel に出ないのは devtools の役割上の欠陥である (statusMessage は最新 1 件しか保持しない)。

本 issue では以下を対象にする。

- (A) `useSubscriber.ts` の `connect` 内 `close` / `error` コールバック
- (B) `usePublisher.ts` の `connect` 内 `close` / `error` コールバック
- (C) `useSubscriber.ts` の Catalog 購読ライフサイクル系 `console.*` (`Catalog received` / `Catalog stream ended` / `Catalog subscribe error` / `No video tracks in catalog` / `Failed to decode catalog` / `Using codec from catalog`)

**本 issue で扱わないもの** (理由は「対象外と分類した console.\* 一覧」参照):

- `renderFrame` / `handleObject` 内の `console.warn` / `console.error` (フレーム per-object のホットパス。ログ洪水になるため別 issue で扱う)
- Decoder error / reset / configured ログ
- Joining Fetch 系の `console.log` (`started` / `skipped` / `completed`) と `onError`
- Track ライブ購読の `Subscriber error` / `Connection error` / `requestKeyframe` 周りの `console.*`
- `usePublisher.ts` 内のデコーダ・エンコーダ・stream 取得など接続イベント以外の `console.*`

これらを一括で addLog 化すると「DebugPanel に同じ情報が二重に出る」「ホットパスでログが爆発する」「issue 粒度が大きくなりすぎて差分レビューが破綻する」ため、本 issue は **接続ライフサイクル (`connect` の `close` / `error`) と Catalog 取得フェーズに限定**する。残りは別 issue で個別に判断する。

## 根拠

### 接続ライフサイクル (A)(B)

`useSubscriber.ts:230-247` (`session = await connect(...)`):

```ts
close: (closeInfo) => {
  console.log(
    `Subscriber: WebTransport closed: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`,
  );
  instance.status.value = "disconnected";
  instance.statusMessage.value = `Disconnected: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`;
  cleanupSubscriber();
},
error: (error) => {
  instance.status.value = "error";
  instance.statusMessage.value = `Error: ${error.message}`;
  cleanupSubscriber();
},
```

`usePublisher.ts:272-285` (`session = await connect(...)`):

```ts
close: (closeInfo) => {
  console.log(
    `Publisher: WebTransport closed: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`,
  );
  pub.pubStatus.value = "disconnected";
  pub.pubStatusMessage.value = `Disconnected: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`;
  cleanupPublisher();
},
error: (error) => {
  pub.pubStatus.value = "error";
  pub.pubStatusMessage.value = `Error: ${error.message}`;
  cleanupPublisher();
},
```

ここを `addLog` 化しないと、サーバ切断・証明書エラー・I/O 失敗が `statusMessage` 1 行と DevTools コンソールにしか残らない。DebugPanel から問題を切り分けられない。

### Catalog ライフサイクル (C)

`useSubscriber.ts` 内に Catalog 関連の `console.*` が点在しているが、`addLog` 経由のものと混在しているので「DebugPanel から見える Catalog の流れ」が不完全:

- `:272` で受信時に `addLog("info", "[<id>] [RECV] OBJECT (<CATALOG_TRACK_NAME>)", { source, catalog })` を呼んでいる **直後** に
- `:276` で `console.log("Catalog received ...")` も呼んでおり、片方は DebugPanel に出るが情報が重複している
- `:302` (Catalog stream ended)・`:305` (Catalog subscribe error)・`:283` (No video tracks)・`:287` (Failed to decode catalog) は DebugPanel に出ない

`addLog("info", "[<id>] Catalog Joining FETCH completed", ...)` (321 行目) のように既に一部は addLog 経由化されているので、整合性をとる。

## `useSubscriber.ts` / `usePublisher.ts` 内 `console.*` 全数表 (本 issue の対象/非対象を明示)

`useSubscriber.ts`:

| 行 | コンテキスト | level | 本 issue 対象 | 備考 |
| ---- | ----------- | ----- | ------------- | ---- |
| 116  | `renderFrame`: canvas null | warn | 非対象 | フレーム描画ホットパス。別 issue |
| 123  | `renderFrame`: 2d context 取得失敗 | warn | 非対象 | 同上 |
| 145  | `handleObject`: decoder null | warn | 非対象 | OBJECT per-object ホットパス。別 issue |
| 196  | `handleObject`: decoder not configured | warn | 非対象 | 同上 |
| 208  | `handleObject`: decode 失敗 | error | 非対象 | 同上 (`decodeErrors` で別途カウント) |
| 232  | `connect` の `close` cb | log → warn | **対象 (A)** | |
| 239- | `connect` の `error` cb (現在 console 呼び出しなし、statusMessage 更新のみ) | (なし) | **対象 (A)** | `addLog("error", ...)` を新規追加 |
| 272  | `addLog("info", "[<id>] [RECV] OBJECT (<CATALOG_TRACK_NAME>)", ...)` | (既に addLog) | 参照のみ | `:276` と重複しているので `:276` を削除 |
| 276  | `Catalog received (...)` | log | **対象 (C)** | `:272` と重複。削除する |
| 283  | `No video tracks in catalog` | warn | **対象 (C)** | addLog 化 |
| 287  | `Failed to decode catalog` | error | **対象 (C)** | addLog 化 (`reject(error)` は維持) |
| 302  | `Catalog stream ended` | log | **対象 (C)** | addLog 化 (level=info) |
| 305  | `Catalog subscribe error` | error | **対象 (C)** | addLog 化 (`reject(error)` は維持) |
| 355  | `Using codec from catalog` | log | **対象 (C)** | addLog 化 (level=info)。Catalog 完了通知 |
| 375  | Decoder error | error | 非対象 | 別 issue (デコーダ系)。`decodeErrors` 増分は維持 |
| 378  | Resetting decoder | log | 非対象 | 同上 |
| 386  | Decoder configured | log | 非対象 | 同上 |
| 437  | Joining Fetch: started | log | 非対象 | 別 issue (Joining Fetch 系) |
| 479  | Joining Fetch: skipped N | log | 非対象 | 同上 |
| 485  | Joining Fetch: completed | log | 非対象 | 同上 |
| 513  | `joiningFetch: error` | error | 非対象 | 同上 |
| 556  | `Subscriber error` (track の error cb) | error | 非対象 | 別 issue (ライブ購読系) |
| 570  | `Connection error` (`startSubscribing` catch) | error | 非対象 | 別 issue。`statusMessage` で UI には出る |
| 663  | `requestKeyframe`: not active | warn | 非対象 | 別 issue |
| 680  | `requestKeyframe`: failed | error | 非対象 | 同上 |

`usePublisher.ts`:

| 行 | コンテキスト | level | 本 issue 対象 | 備考 |
| ---- | ----------- | ----- | ------------- | ---- |
| 118  | `startPreview` catch | error | 非対象 | 別 issue (Preview 系) |
| 147 / 151 / 152 / 158 / 170 / 172 / 173 | `processFrames` 周り | log/error | 非対象 | エンコードホットパス。別 issue |
| 229 / 243 / 269 / 290 / 345 / 352 / 354 / 368 / 376 / 381 / 401 / 421 / 425 / 449 / 459 | `startPublishing` 進捗 log | log | 非対象 | 別 issue (Publisher 起動シーケンス) |
| 274  | `connect` の `close` cb | log → warn | **対象 (B)** | |
| 281- | `connect` の `error` cb | (なし) | **対象 (B)** | `addLog("error", ...)` を新規追加 |
| 303  | Catalog publisher error | error | 非対象 | 別 issue (Publisher publish 系) |
| 387  | Track publisher error | error | 非対象 | 同上 |
| 432  | Encoder error | error | 非対象 | 同上 (エンコーダ系) |
| 475  | `startPublishing` catch | error | 非対象 | 同上 |

## 修正方針

### `useSubscriber.ts`

1. `close` コールバック (232-238 行目): `console.log(...)` を削除し、ハンドラ先頭で

   ```ts
   addLog("warn", `[${subscriberId}] WebTransport closed`, {
     closeCode: closeInfo.closeCode,
     reason: closeInfo.reason,
   });
   ```

   `statusMessage` の更新・`cleanupSubscriber()` の呼び出しはそのまま残す。`closeCode` は `0` (正常切断) のケースを含むため level は `warn` 固定とする (利用者にとって「予期せず切れたかどうか」は `statusMessage` と組み合わせて読む)。

2. `error` コールバック (239-243 行目): 現状 `console.*` は無いが、エラー情報が DebugPanel に出ないのが本 issue の主課題なので

   ```ts
   addLog("error", `[${subscriberId}] WebTransport error`, {
     message: error.message,
   });
   ```

   を先頭に追加する。`error.message` 以外のプロパティ (`name`, `stack`) は含めない (`stack` をログに残すと payload と同様に文字列がメモリに長期保持されるが、サイズは無視できるため許容)。

3. Catalog 経路の console を addLog に置換:
   - `:276` `console.log(`[${subscriberId}] Catalog received (${source}):`, catalog)` を **削除** する (`:272` の `addLog` と完全重複)
   - `:283` `console.warn(`[${subscriberId}] No video tracks in catalog`)` →
     `addLog("warn", `[${subscriberId}] no video tracks in catalog`);`
   - `:287` `console.error(`[${subscriberId}] Failed to decode catalog:`, error)` →
     `addLog("error", `[${subscriberId}] failed to decode catalog`, { message: (error as Error).message });`
     `reject(error)` は維持
   - `:302` `console.log(`[${subscriberId}] Catalog stream ended`)` →
     `addLog("info", `[${subscriberId}] catalog stream ended`);`
   - `:305` `console.error(`[${subscriberId}] Catalog subscribe error:`, error)` →
     `addLog("error", `[${subscriberId}] catalog subscribe error`, { message: error.message });`
     `reject(error)` は維持
   - `:355` `console.log(`[${subscriberId}] Using codec from catalog:`, videoTrackFromCatalog.codec)` →
     `addLog("info", `[${subscriberId}] using codec from catalog`, { codec: videoTrackFromCatalog.codec });`

4. メッセージ表記の統一: 上記すべてのメッセージは英語小文字始まりとする (CLAUDE.md「ログメッセージは全て英語」「エラーメッセージは全て英語 / 小文字で始めること」)。**先頭の `[${subscriberId}]` プレフィックスは Subscriber を識別するために維持する** (`handleDebugMessage` と同じ形式)。

### `usePublisher.ts`

1. `close` コールバック (273-280 行目): `console.log(...)` を削除し、

   ```ts
   addLog("warn", `[publisher] WebTransport closed`, {
     closeCode: closeInfo.closeCode,
     reason: closeInfo.reason,
   });
   ```

   `pub.pubStatus` / `pub.pubStatusMessage` / `cleanupPublisher()` はそのまま残す。

2. `error` コールバック (281-285 行目):

   ```ts
   addLog("error", `[publisher] WebTransport error`, {
     message: error.message,
   });
   ```

   を先頭に追加する。

3. Publisher 側の Catalog 系 (`:303` Catalog publisher error など) は本 issue では触らない。Publisher の Catalog エラー導線は subscriber 側と非対称な処理が絡むため、別 issue で `[publisher]` プレフィックス込みで整理する。

### 共通

- `addLog` の data 引数に渡す `closeInfo.reason` は API 上 `string` だが任意長になるため、巨大文字列が来てもログ全体を破壊しないよう **そのまま渡す** (DebugPanel 側で hex dump はしない)。MAX_LOGS で頭打ちされるため長期メモリリスクなし。
- WebTransport の `close` コールバックは「実装が同期 dispatch する」既知挙動 (`cleanupSubscriber` の再入対策コメント参照, useSubscriber.ts:626-630)。`addLog` 自体は副作用が無く再入安全なので順序問題は生じない。

## 関連 issue

- `issues/closed/0149-fix-clipboard-error-handling-debug-panel.md` (DebugPanel 側 clipboard try/catch。本 issue とは独立で、addLog 側の経路に影響しない)
- `issues/0167-perf-debug-panel-log-buffer-and-autoscroll.md` (`addLog` の内部実装をプレーン配列 + シーケンス signal に作り直す予定。本 issue は **`addLog` の呼び出し側のみ** を変更するため、0167 のマージ順に依存しない: 呼び出しシグネチャは維持される)
- `issues/0175-fix-handle-debug-message-copy-payload-for-log-retention.md` (`handleDebugMessage` の payload コピー。本 issue は payload を `addLog` に渡さないため独立)

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` (close/error + Catalog 経路 6 箇所の置換)
- `devtools/src/hooks/usePublisher.ts` (close/error 2 箇所)

## テスト戦略

CLAUDE.md「Vitest の Chai API である test / assert を利用」「モックやスタブは利用しない」に従う。WebTransport の `close` / `error` を実環境で再現するテストは現実的でないため、**単体テスト + 手動確認** で押さえる。

### 単体テスト (新規)

WebTransport の `connect` を実行せずに addLog 呼び出しだけ検証する都合上、現在のコードは `connect` の中にクロージャがあって直接呼べない。本 issue ではテスト用のテストヘルパは追加しない方針とし、以下の手動確認をもって完了とする。

**理由**: クロージャを抽出して export 関数化するリファクタは別 issue の範疇 (ハンドラ抽出は単体テスト容易性のための変更で、本 issue の目的「ログ経路の一元化」とスコープが異なる)。テスト容易性を求める場合は別 issue 化する。

### 手動確認

1. devtools をビルド (`vp run build:devtools`) して `pnpm dev` で起動する
2. Subscriber:
   - 存在しないサーバ URL を指定して接続 → DebugPanel に `WebTransport error` または `failed to get catalog` 系のエラーが流れること
   - 正常接続後にサーバを停止 → DebugPanel に `[<subscriberId>] WebTransport closed` が level=warn で流れること
   - Catalog Subscribe フェーズで意図的に namespace を間違える → `[<subscriberId>] catalog subscribe error` が流れること
3. Publisher:
   - 正常接続後にサーバを停止 → DebugPanel に `[publisher] WebTransport closed` が level=warn で流れること
   - 接続不能サーバへ向けて publish → `[publisher] WebTransport error` が流れること
4. 既存ログとの重複が無いこと (`Catalog received` が DebugPanel に二重表示されないこと)

### 自動テスト

- `vp run test` で既存テスト全部がパスすること
- `vp run build:devtools` がパスすること

## CHANGES.md 記載方針

`### misc` サブセクションに `[UPDATE]` で記載する。devtools 内部の挙動変更で公開 API への影響なし。

文面例:

```
- [UPDATE] devtools の `useSubscriber` / `usePublisher` で WebTransport `close` / `error` と Catalog ライフサイクルを `addLog` 経由で DebugPanel に出力する
```

## 完了条件

- `useSubscriber.ts` の `connect` の `close` / `error` コールバックが `addLog` を呼ぶ
- `usePublisher.ts` の `connect` の `close` / `error` コールバックが `addLog` を呼ぶ
- `useSubscriber.ts` 内の Catalog 経路 6 箇所 (`:276` 削除、`:283` / `:287` / `:302` / `:305` / `:355` を addLog 化) が完了している
- `useSubscriber.ts` / `usePublisher.ts` 内で本 issue 対象外と分類した `console.*` は **変更しない**
- DebugPanel に重複ログ (`Catalog received` が 2 件) が出ないこと (手動確認)
- `vp run test` が成功する
- `vp run build:devtools` が成功する
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` エントリが追加されている
