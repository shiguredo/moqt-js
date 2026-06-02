# STOP_SENDING / delivery timeout 後に閉じた Subgroup への送信を禁止する

Created: 2026-05-13
Completed: 2026-06-02
Model: Opus 4.7
Branch: feature/draft-18

## 概要

`src/session.ts:828-838` に TODO として残っている Subgroup 再開禁止の実装が未完了である。
現在の 1 Group = 1 Subgroup = 1 Stream モデルでは groupId が変われば自然と新しいストリームが
作成されるが、同一 groupId のストリームが STOP_SENDING を受信して writer が破壊された後も
`sendObjectInternal` が writer への書き込みを試行し続ける経路が存在する。
これを検出して事前に拒否する必要がある。

## 再現手順

1. Publisher で Subgroup (trackAlias, groupId) に `sendObject` を送信する
2. relay または subscriber が STOP_SENDING を送出し、writer が破壊される
3. 同一 (trackAlias, groupId) で再度 `sendObject` を呼び出す
4. 現在の動作: `writer.write()` のエラーが未ハンドリングのまま伝搬する
5. 期待する動作: `ClosedSubgroupError` が throw され上位に通知される

## 一次資料の引用

draft-ietf-moq-transport-18 §10.2.4 (OBJECT_DELIVERY_TIMEOUT Parameter) は relay に対する規定であり、
クライアント側 Publisher への対応する規定は §11.4.3 にある:

> A publisher that receives a STOP_SENDING on a Subgroup stream SHOULD
> NOT attempt to open a new stream to deliver additional Objects in
> that Subgroup.

§11.4.3 には以下の補足もある:

> Resets and STOP_SENDING on SUBSCRIBE data streams have no impact on
> other Subgroups in the Group or the subscription.

規定の強制力は SHOULD NOT である。RFC 2119 において SHOULD NOT は「特定の状況下では
違反が許容される」推奨禁止事項であるが、moqt-js はクライアント側 Publisher であり、
subscriber (relay) からの STOP_SENDING は「そのデータは不要」という明示的な意思表明である。
クライアント側 Publisher がこれを無視して再送する合理的なユースケースは存在せず、
relay のように別 subscriber 向けに再送する立場でもないため、
閉じた Subgroup への送信を一律に拒否する実装方針を採る。

## 該当コード

`src/session.ts:828-838`（TODO コメント内の Section 11.4.2 は誤りであり、正しくは §11.4.3）:

```typescript
// TODO: Closed Subgroup Tracking
// draft-ietf-moq-transport-18:
// delivery timeout または STOP_SENDING 後に Subgroup を再オープンしてはならない。
// draft-ietf-moq-transport-18 Section 11.4.3 (Closing Subgroup Streams)
//
// 現在の実装では 1 Group = 1 Subgroup = 1 Stream モデルを採用しているため、
// グループが終了すると自然と新しいストリームを作成する。
// 完全な実装には以下が必要:
// 1. WebTransport の STOP_SENDING シグナル検出
// 2. 閉じた Subgroup (trackAlias, groupId, subgroupId) の追跡
// 3. sendObject 時に閉じた Subgroup への送信を拒否
```

## 影響範囲

- `src/session.ts`:
  - `closedSubgroups` の追加と `sendObject` Promise チェーン内での拒否
  - STOP_SENDING 検出と `closedSubgroups` への追加
  - `closedSubgroups` のクリア（publisher done / session close）
- `src/error.ts`: `ClosedSubgroupError` エラー型の新設

## 実装方針

### 1. `closedSubgroups` の管理

`SessionImpl` に `closedSubgroups: Set<string>` を追加する。
1 Group = 1 Subgroup = 1 Stream モデルでは groupId が subgroupId を一意に決定するため、
キーは `"${trackAlias}:${groupId}"` で十分である。

### 2. STOP_SENDING の検出

Publisher 側で STOP_SENDING を検出する方法:

- `sendObjectInternal` 内の `await streamState.writer.write(data)` の throw を主検出とする
- writer 作成直後に `writer.closed.catch()` を補助検出として仕掛ける。
  `(trackAlias, groupId)` はクロージャでキャプチャする

`sendObject` の Promise チェーン最終段 `.catch((err) => { ... })` 内で、
`err` が `WebTransportError` であるか writer 状態から STOP_SENDING 由来と判定し、
当該 `(trackAlias, groupId)` を `closedSubgroups` に追加した後、
既存の `publisher.handleError(err instanceof Error ? err : new Error(String(err)))` を呼ぶ。

注意: `writer.close()` (グループ変更時の旧ストリーム close) の失敗は
STOP_SENDING とみなさない。publisher が自発的に閉じるストリームの close 失敗は
追跡不要である。

### 3. delivery timeout の検出

relay が delivery timeout を検出して RESET_STREAM を送信した場合、
`writer.write()` の throw として STOP_SENDING と同じ経路で検出する。
自前タイマー方式はクライアント側 Publisher の責務範囲外のため実装しない。

### 4. `sendObject` での拒否

`sendObject` の Promise チェーン内で `closedSubgroups` チェックを行う:

```
previousPromise
  .catch(() => {})  // 既存のエラー握りつぶし（削除しない）
  .then(() => {
    if (this.closedSubgroups.has(`${trackAlias}:${groupId}`)) {
      throw new ClosedSubgroupError(
        `subgroup is closed: trackAlias=${trackAlias} groupId=${groupId}`,
        trackAlias,
        groupId,
      );
    }
  })
  .then(() => this.sendObjectInternal(publisher, params))
  .catch((err) => {
    // STOP_SENDING 判定 → closedSubgroups 追加（実装方針 2 参照）
    publisher.handleError(err instanceof Error ? err : new Error(String(err)));
  })
```

Promise チェーンの `.then()` でチェックすることで、先行する `sendObjectInternal` が
STOP_SENDING を検出して `closedSubgroups` に追加した後に、後続の呼び出しが
正しくブロックされる。

### 5. `ClosedSubgroupError` の定義

`src/error.ts` に以下を追加する。プロトコルエラーコードを持たない内部エラーであるため、
`IncompleteDataError` / `ProtocolViolationError` / `MalformedTrackError` と同様に
`Error` を直接継承する:

```typescript
export class ClosedSubgroupError extends Error {
  constructor(
    message: string,
    readonly trackAlias: bigint,
    readonly groupId: bigint,
  ) {
    super(message);
    this.name = "ClosedSubgroupError";
  }
}
```

### 6. `closedSubgroups` のクリア

- `publisher.done()` の `onDoneInternal` 完了後、`closePublisherStream` の
  Promise チェーン末尾で当該 trackAlias のエントリを Set からフィルタ除去する
- セッション終了時に全エントリをクリアする
- 長時間稼働時のメモリリークを防ぐため、単調増加させない

## エッジケース

- `writer.close()` 実行中の STOP_SENDING 受信:
  `writer.close()` の catch 内で既に握りつぶされるが、`writer.closed.catch()` の
  補助検出により `closedSubgroups` に追加する。
- 新ストリーム作成直後（header 書き込み後、最初の object write 前）の STOP_SENDING:
  `closedSubgroups` に追加後、後続の `sendObject` が拒否される。
- 同一 publisher で複数 `sendObject` が Promise チェーンで直列化されている場合:
  `.then()` 内のチェックにより後続の全 write がブロックされる。
- 複数 publisher が同一 session 上に存在する場合:
  キーに `trackAlias` を含むため異なる publisher 間で干渉しない。

## テスト戦略

- `ClosedSubgroupError` が `Error` を継承し `name` / `trackAlias` / `groupId` を
  正しく保持すること（`error.test.ts` に追加）
- `closedSubgroups` に追加済みの Subgroup への `sendObject` で
  `ClosedSubgroupError` が throw されること
- `closedSubgroups` に存在しない Subgroup への `sendObject` が成功すること
- `publisher.done()` 呼び出し後に `closedSubgroups` の該当エントリがクリアされること
- 複数 publisher 間で `closedSubgroups` が干渉しないこと
- `ClosedSubgroupError` が `publisher.handleError()` 経由でアプリケーションに伝搬すること

注意: `closedSubgroups` の操作検証には `SessionImpl` の内部状態へのアクセスが
必要なため、`sendObject` の呼び出し経路を通した統合的なテストとなる。
PBT (`.prop.ts`) は `writer.closed` の reject 模擬にモックが必要となるため、
本 issue の範囲では単体テストに限定する。

## 完了条件

- TODO コメント (828-838 行) が削除され、実装で置き換えられている
- `sendObject` Promise チェーン内で閉じた Subgroup への送信を拒否する
- `closedSubgroups` が publisher done / session close 時に適切にクリアされる
- CHANGES.md の `## develop` に `[FIX]` エントリを追加し、
  行 334 の「未対応: Subgroup 再オープン禁止」を削除する
- `vp run test` 全パス
- `vp run build` 成功

## 解決方法

- `src/error.ts`: `ClosedSubgroupError` クラスを新設し、閉じた Subgroup への送信拒否時に throw する内部エラー型として使用する
- `src/error.test.ts`: `ClosedSubgroupError` が `Error` を継承し `name` / `trackAlias` / `groupId` を正しく保持するテストを追加
- `src/index.ts`: `ClosedSubgroupError` を公開 export に追加し、アプリケーションから `instanceof` 判定可能にする
- `src/session.ts`:
  - `closedSubgroups: Set<string>` フィールドを追加し、TODO コメントを実装で置き換える
  - `sendObject` の Promise チェーンに `.then()` を追加し、`sendObjectInternal` 呼び出し前に `closedSubgroups` をチェックして送信を拒否する
  - `sendObjectInternal` の `writer.write()` 呼び出しを try/catch で囲み、失敗時に `closedSubgroups` へ追加・ロック解放・rethrow を行う
  - `closePublisherStreamInternal` で publisher done 時に当該 trackAlias の `closedSubgroups` エントリをクリアする
  - `close()` でセッション終了時に `closedSubgroups` を全クリアする
- `CHANGES.md`:
  - `## 2026.2.0` セクションの「未対応: Subgroup 再オープン禁止」行を削除
  - `## develop` セクションに `[FIX]` エントリを追加
- 既存テスト `vp run test` 586 件全パス、`vp run build` 成功
