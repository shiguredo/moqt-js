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

これらを一括で addLog 化すると「DebugPanel に同じ情報が二重に出る」「ホットパスでログが爆発する」「issue 粒度が大きくなりすぎて差分レビューが破綻する」ため、本 issue は **接続ライフサイクル (`connect` の `close` / `error`) と Catalog 取得フェーズに限定**する。残り (`renderFrame` / `handleObject` ホットパス、Decoder 系、Joining Fetch 系、ライブ購読 (`Subscriber error` / `Connection error`)、`requestKeyframe`、Publisher 起動シーケンス、Publisher Catalog / Track publish 系) は本 issue 完了時に SEQUENCE から番号を払い出してそれぞれ後続 issue を起票する。後続 issue を起票しないと console 散乱が永久に残るため、必ず起票する。

## 根拠

### 接続ライフサイクル (A)(B)

`useSubscriber.ts:230-247` (`session = await connect(...)`):

```ts
close: (closeInfo) => {
  console.log(
    `Subscriber: webtransport closed: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`,
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
    `Publisher: webtransport closed: closeCode=${closeInfo.closeCode}, reason=${closeInfo.reason}`,
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
   addLog("warn", `[${subscriberId}] webtransport closed`, {
     closeCode: closeInfo.closeCode,
     reason: closeInfo.reason,
   });
   ```

   `statusMessage` の更新・`cleanupSubscriber()` の呼び出しはそのまま残す。`closeCode` は `0` (正常切断) のケースを含むため level は `warn` 固定とする (利用者にとって「予期せず切れたかどうか」は `statusMessage` と組み合わせて読む)。

2. `error` コールバック (239-243 行目): 現状 `console.*` は無いが、エラー情報が DebugPanel に出ないのが本 issue の主課題なので

   ```ts
   addLog("error", `[${subscriberId}] webtransport error`, {
     name: error.name ?? "Error",
     message: error.message ?? String(error),
   });
   ```

   を先頭に追加する。`name` は `WebTransportError` / `DOMException` の判別に必要。`stack` は長文字列のためログには含めない。`error` が `null` / `undefined` の防御は `error.message ?? String(error)` で行う。

3. Catalog 経路の console を addLog に置換:
   - `:276` `console.log(`[${subscriberId}] Catalog received (${source}):`, catalog)` を **削除** する (`:272` の `addLog` と完全重複)
   - `:283` `console.warn(`[${subscriberId}] No video tracks in catalog`)` →
     `addLog("warn", `[${subscriberId}] no video tracks in catalog`);`
   - `:287` `console.error(`[${subscriberId}] Failed to decode catalog:`, error)` →
     `addLog("error", `[${subscriberId}] failed to decode catalog`, { message: error instanceof Error ? error.message : String(error) });`
     `reject(error)` は維持
   - `:302` `console.log(`[${subscriberId}] Catalog stream ended`)` →
     `addLog("info", `[${subscriberId}] catalog stream ended`);`
   - `:305` `console.error(`[${subscriberId}] Catalog subscribe error:`, error)` →
     `addLog("error", `[${subscriberId}] catalog subscribe error`, { message: error instanceof Error ? error.message : String(error) });`
     `reject(error)` は維持
   - `:355` `console.log(`[${subscriberId}] Using codec from catalog:`, videoTrackFromCatalog.codec)` →
     `addLog("info", `[${subscriberId}] using codec from catalog`, { codec: videoTrackFromCatalog.codec });`

4. メッセージ表記の統一: 上記すべてのメッセージは英語小文字始まりとする (CLAUDE.md「ログメッセージは全て英語」「エラーメッセージは全て英語 / 小文字で始めること」)。**先頭の `[${subscriberId}]` プレフィックスは Subscriber を識別するために維持する** (`handleDebugMessage` と同じ形式)。

### `usePublisher.ts`

1. `close` コールバック (273-280 行目): `console.log(...)` を削除し、

   ```ts
   addLog("warn", `[publisher] webtransport closed`, {
     closeCode: closeInfo.closeCode,
     reason: closeInfo.reason,
   });
   ```

   `pub.pubStatus` / `pub.pubStatusMessage` / `cleanupPublisher()` はそのまま残す。

2. `error` コールバック (281-285 行目):

   ```ts
   addLog("error", `[publisher] webtransport error`, {
     name: error.name ?? "Error",
     message: error.message ?? String(error),
   });
   ```

   を先頭に追加する。`name` は `WebTransportError` / `DOMException` の判別用、`null` / `undefined` 防御は `String(error)` フォールバック。`[publisher]` プレフィックスを使うのは Publisher が単一インスタンス (`pub.publisher.value` が単一 signal) のため。

3. Publisher 側の Catalog 系 (`:303` Catalog publisher error など) は本 issue では触らない。Publisher の Catalog エラー導線は subscriber 側と非対称な処理が絡むため、別 issue で `[publisher]` プレフィックス込みで整理する。

### 共通

- `addLog` の data 引数に渡す `closeInfo.reason` は API 上 `string` だが任意長。`reason.slice(0, 1024)` で 1024 文字に切ってから渡す。DebugPanel の UI 描画が長大文字列で重くなるリスクを避ける
- WebTransport の `close` コールバックは「実装が同期 dispatch する」既知挙動 (`cleanupSubscriber` の再入対策コメント参照, useSubscriber.ts:626-630)。`addLog` の副作用は signal への単純書き込みのみで `cleanupSubscriber` からの再入経路で順序問題は生じない

## 関連 issue

- `issues/0163-fix-stop-subscribing-cleanup-reentry-race.md` (close / end / error コールバック先頭に `shouldApplyStatusUpdate` ガードを差し込む)。**本 issue の `addLog` 呼び出しは `shouldApplyStatusUpdate` ガードの「外」 (= コールバック先頭)** に置く。stop 主導の終端でも外因の終端でも DebugPanel にイベント記録を残すのが本 issue の目的のため、ガードで抑止すると目的に反する。ガードは `status` / `statusMessage` 書き換えと `cleanupSubscriber` (0171 適用後は `teardownSubscriber`) の挙動にのみ影響し、`addLog` は影響を受けない。先後どちらでも実装可能だが、両方適用後の最終形を「`addLog` をガード外、`status` 書き換えと `cleanupSubscriber` をガード内」と明示する
- `issues/closed/0149-fix-clipboard-error-handling-debug-panel.md` (DebugPanel 側 clipboard try/catch。本 issue とは独立)
- `issues/0167-perf-debug-panel-log-buffer-and-autoscroll.md` (`addLog` の内部実装をプレーン配列 + シーケンス signal に作り直す予定)。本 issue は **`addLog` の呼び出し側のみ** を変更するため、0167 のマージ順に依存しない。本 issue では `addLog(level, message, data)` の **3 引数形** で呼び出し、`payload` (第 4 引数) は渡さない
- `issues/0175-fix-handle-debug-message-copy-payload-for-log-retention.md` (`handleDebugMessage` の payload コピー)。本 issue は `payload` を渡さないため独立

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` (close/error + Catalog 経路 6 箇所の置換)
- `devtools/src/hooks/usePublisher.ts` (close/error 2 箇所)

## テスト戦略

CLAUDE.md「Vitest の Chai API である test / assert を利用」「モックやスタブは利用しない」に従う。WebTransport の `close` / `error` を実環境で再現するテストは現実的でないため、**単体テスト + 手動確認** で押さえる。

### 自動テスト

本 issue では自動テストを追加しない。`connect` の `close` / `error` コールバックはクロージャ内に閉じており直接呼び出せず、export 関数化リファクタは本 issue の目的「ログ経路の一元化」とスコープが異なる。テスト容易性を求める場合は別 issue で扱う。

### 手動確認

1. devtools をビルド (`vp run build:devtools`) して `pnpm dev` で起動する
2. Subscriber:
   - 存在しないサーバ URL を指定して接続 → DebugPanel に `webtransport error` または `failed to get catalog` 系のエラーが流れること
   - 正常接続後にサーバを停止 → DebugPanel に `[<subscriberId>] webtransport closed` が level=warn で流れること
   - Catalog Subscribe フェーズで意図的に namespace を間違える → `[<subscriberId>] catalog subscribe error` が流れること
3. Publisher:
   - 正常接続後にサーバを停止 → DebugPanel に `[publisher] webtransport closed` が level=warn で流れること
   - 接続不能サーバへ向けて publish → `[publisher] webtransport error` が流れること
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
- `useSubscriber.ts` 内の Catalog 経路 (`:276` の `console.log` 削除 1 箇所 + `:283` / `:287` / `:302` / `:305` / `:355` の addLog 化 5 箇所、合計 6 箇所) が完了している
- 本 issue の `addLog` 呼び出しは `shouldApplyStatusUpdate` ガード (0163) の **外** (= コールバック先頭) に置く
- `addLog` は `(level, message, data)` の 3 引数形で呼び、`payload` (第 4 引数) は渡さない
- 本 issue 完了時に、対象外と分類した console 群を扱う後続 issue を SEQUENCE から番号払い出して起票する
- `useSubscriber.ts` / `usePublisher.ts` 内で本 issue 対象外と分類した `console.*` は **変更しない**
- DebugPanel に重複ログ (`Catalog received` が 2 件) が出ないこと (手動確認)
- `vp run test` が成功する
- `vp run build:devtools` が成功する
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` エントリが追加されている
