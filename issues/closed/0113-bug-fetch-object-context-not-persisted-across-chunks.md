# FETCH ストリームの decode context が複数チャンクで永続化されない

Created: 2026-04-30
Completed: 2026-04-30
Model: Opus 4.7

## 概要

`src/session.ts` の `processFetchObjects` (line 3837) は内部で `currentContext` / `currentIsFirst` を更新するが、戻り値として返していない。caller の `handleIncomingStream` (line 3776-3783) は `fetchContext` / `isFirstFetchObject` をクロージャ変数として持つが、`processFetchObjects` の戻り値からこれらを書き戻していない。さらに caller の `if (buffer !== null)` 判定 (line 3781) は `processFetchObjects` が常に `Uint8Array` を返すため常に true で、`isFirstFetchObject = false` への切替も実質ガードされていない。

結果として FETCH ストリームが複数チャンクに分割されると、2 つ目以降のチャンクで `fetchContext = null` のまま `decodeFetchObjectFields` が呼ばれる。後続オブジェクトは prior context を参照するため GROUP_ID_PRESENT 等のフラグを省略しているが、`decodeFetchObjectFields` (`src/dataStream.ts:1124`) は「`isFirst || context === null` なのに GROUP_ID_PRESENT が無い」と判定して `ProtocolViolationError("first object must have GROUP_ID_PRESENT flag set")` を投げる。新しい受信ループ (issue 0109 で導入) はこれを上位に伝播してストリームを終了させるため、moqt-devtools の subscriber で joining fetch / 大きな FETCH レスポンスが失敗する。

issue 0109 (decode 例外の型分類) より前は `} catch { break; }` で全ての例外を握り潰していたため、本バグは silent fail として隠れていた。0109 で `IncompleteDataError` のみを「次のチャンクを待つ」と扱うようにした結果、`ProtocolViolationError` が caller に伝播し、本バグが顕在化した。

## 根拠

`processSubgroupObjects` (`src/session.ts:3811-3833`) は `previousObjectId` を戻り値 `{ remainingBuffer, previousObjectId }` に含めて caller がクロージャ変数に書き戻す形になっており、複数チャンクをまたいだ状態保持が正しく機能している。`processFetchObjects` も同様の構造にすべきだが、現状は `Uint8Array` のみを返しており非対称。caller 側の `if (buffer !== null)` ガードが死んでいる事実からも、設計上の漏れであることが明らか。

## 該当コード

### caller (`src/session.ts:3776-3783`)

```typescript
if (headerParsed) {
  if (isFetchStream && fetcher && fetchHeader) {
    // Fetch オブジェクトをストリーミング処理
    buffer = this.processFetchObjects(buffer, fetcher, fetchContext, isFirstFetchObject);
    // 状態を更新 (最初のオブジェクトが処理されたかどうか)
    if (buffer !== null) {
      isFirstFetchObject = false;
    }
  } else if (!isFetchStream && subscriber && subgroupHeader) {
    ...
  }
}
```

`fetchContext` の更新が無く、`if (buffer !== null)` も `Uint8Array` 戻り値に対して常に true。

### `processFetchObjects` 本体 (`src/session.ts:3837-3905`)

```typescript
private processFetchObjects(
  buffer: Uint8Array,
  fetcher: FetcherImpl,
  context: import("./dataStream").FetchObjectContext | null,
  isFirst: boolean,
): Uint8Array {
  let offset = 0;
  let currentContext = context;
  let currentIsFirst = isFirst;
  ...
  return buffer.slice(offset);
}
```

`currentContext` / `currentIsFirst` を更新しても戻り値に含めていない。

### `decodeFetchObjectFields` の検査 (`src/dataStream.ts:1118-1125`)

```typescript
} else {
  if (isFirst || context === null) {
    throw new ProtocolViolationError("first object must have GROUP_ID_PRESENT flag set");
  }
  groupId = context.groupId;
}
```

仕様上正しい検査だが、caller 側が context を渡せていないため誤発動する。

### 比較: `processSubgroupObjects` (`src/session.ts:3811-3833`)

```typescript
const result = this.processSubgroupObjects(buffer, subscriber, subgroupHeader, previousObjectId);
buffer = result.remainingBuffer;
previousObjectId = result.previousObjectId;
```

戻り値で `previousObjectId` を threading しており、こちらは正しく動作している。

## 影響

- **joining fetch の失敗**: SUBSCRIBE_OK の `largestLocation` から過去キャッシュを Joining FETCH で取得する際、キャッシュサイズが 1 チャンクに収まらないと subscriber がエラー終了する。moqt-devtools での subscriber 動作不能の主因。
- **大きな FETCH レスポンスの失敗**: 任意の FETCH で複数チャンクにまたがると同じエラーが発生する。
- **subscriber の異常終了**: ストリーム loop が `ProtocolViolationError` 伝播後 `closeWithError(PROTOCOL_VIOLATION)` でセッションごと閉じる。
- **エラーメッセージの誤誘導**: 実際の原因 (caller の状態 threading 漏れ) ではなく「サーバーが GROUP_ID_PRESENT を立てていない」と誤認させる。

## 修正方針

1. `processFetchObjects` の戻り値型を `{ remainingBuffer: Uint8Array; context: FetchObjectContext | null; isFirst: boolean }` に変更し、`processSubgroupObjects` と対称な形にする。
2. caller (`handleIncomingStream`) で戻り値からクロージャ変数 `fetchContext` / `isFirstFetchObject` に書き戻す。死んでいる `if (buffer !== null)` ガードは削除する。
3. ストリーム終了処理 (line 3804) は戻り値を破棄する形のままで型は通る (戻り値を使わないため)。

## テスト追加方針

- 本バグは `src/session.ts` の受信ループで発生する状態管理の問題であり、`dataStream.ts` レベルの decode 関数自身は仕様通り動作している。session.ts レベルの単体テストは WebTransport 依存で困難。
- 既存の e2e テスト `tests/e2e/pubsub.spec.ts` の `subscribe with joining fetch retrieves cached objects` (line 112-150) が本バグのリグレッションテストとして機能する。`test-results/pubsub-Canvas-pubsub-via-r-c7372-ch-retrieves-cached-objects-chromium/error-context.md` に失敗が記録済み。
- 修正後の検証手順:
  1. `vp run test` で既存の全 394 単体テスト pass を確認
  2. `vp run build` / `vp run build:devtools` 成功を確認
  3. moqt-devtools で joining fetch を有効化して subscriber 起動、Catalog 受信と動画再生を目視確認
  4. e2e は CI で `subscribe with joining fetch retrieves cached objects` の green 復帰を確認

## 関連 issue

- #0109 (`closed`): decode 例外を `IncompleteDataError` / `ProtocolViolationError` で分類した変更。本バグは 0109 で顕在化したが、根本原因は別。0109 自体の修正は仕様準拠で正しい。

## 解決方法

- `src/session.ts` の `processFetchObjects` の戻り値型を `Uint8Array` から `{ remainingBuffer: Uint8Array; context: FetchObjectContext | null; isFirst: boolean }` に変更し、内部で更新する `currentContext` / `currentIsFirst` を caller に返すようにした。`processSubgroupObjects` の `{ remainingBuffer, previousObjectId }` パターンと対称的な設計。
- caller の `handleIncomingStream` (`src/session.ts:3776` 周辺) で戻り値からクロージャ変数 `fetchContext` / `isFirstFetchObject` に書き戻すようにした。機能していなかった `if (buffer !== null)` ガードは削除した。
- ストリーム終了処理 (`src/session.ts:3811` 付近) は戻り値を破棄するだけのため、シグネチャ変更後も無修正で型が通る。
- WebTransport 依存のため自動単体テストは追加せず、`vp run test` (全 394 テスト pass) と既存 e2e (`tests/e2e/pubsub.spec.ts` の `subscribe with joining fetch retrieves cached objects`) でリグレッション確認とする。
