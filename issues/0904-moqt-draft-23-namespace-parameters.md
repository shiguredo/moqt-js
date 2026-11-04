# NAMESPACE に Parameters を追加し同一 namespace の更新を通知する

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §9.15 は NAMESPACE に Number of Parameters と Parameters を追加し、値の変更時に同じ namespace の NAMESPACE を再送すると定めた。現在の codec は suffix のみを期待し、公開 callback で Parameters を受け取れない。

## 現状

- `src/message/namespace.ts` の `Namespace` / `encodeNamespacePayload` / `decodeNamespacePayload` は Track Namespace Suffix しか扱わない
- `src/session/namespaceLoops.ts` の `createNamespaceStreamHandlers` は suffix を active tracker に登録して `onNamespace(suffix)` を呼ぶ
- `src/session/publicTypes.ts` の namespace callbacks に Parameters の情報が無い

## 設計方針

- suffix の直後を count-prefixed Parameters として decode / encode する。現時点で NAMESPACE に定義されていない Parameter を、未知 Detail と同じように無視しない。§9.19 の Message Parameter 規則で検証する
- 公開 callback に Parameters を渡す型を定め、値の更新を同じ namespace の再通知として表現する
- 同じ namespace の再通知で active namespace が二重登録されないようにし、FIN / RESET / NAMESPACE_DONE の補完は 1 回にする
- 0906 の prefix 更新時の active namespace 再構成と接続する

## 完了条件

- 空 Parameters の count も含む新ワイヤ、複数メッセージ連結、切り詰め、余剰バイトを検証する
- 同じ suffix の再通知が callback へ届き、active 状態と終了通知が二重化しない
- codec / Session / 公開型 / API 文書の Parameters の扱いが一致する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §4.2 / §9.15 / §9.19
- `src/message/namespace.ts`、`src/session/namespaceLoops.ts`、`src/session/publicTypes.ts`

## 解決方法

- `src/message/namespace.ts` の NAMESPACE を draft-23 §9.15 のワイヤにした。Track Namespace Suffix の直後に Number of Parameters (vi64) と Parameters を置き、空 Parameters でも count 0 を必ず出力する。decode は §9.19 の Message Parameter 規則 (未知型・重複・delta overflow・切り詰め) を適用し、payload 末尾との一致 (余剰バイト拒否) を維持する。
- `src/message/parameterScope.ts` に `NAMESPACE_ALLOWED_PARAMS` を追加し、§9.19.1 の scope 検証を行う。現在の draft は NAMESPACE に出現できる Parameter を定義していないため空集合とし、既知の型でも NAMESPACE で受信したら INVALID_PARAMETER でセッションを閉じる。拡張が NAMESPACE 用パラメータを定義したときはこの集合だけを更新すればよい。
- `src/session/publicTypes.ts` の `onNamespace` を `(namespaceSuffix, parameters)` に変更し、同じ suffix の再通知を Parameters の更新として表現する型にした。active な期間の 2 回目以降は更新、NAMESPACE_DONE の後に同じ suffix を受けた場合は再追加として扱うことを JSDoc に明記した。
- `src/session/namespaceLoops.ts` で NAMESPACE 受信時に scope 検証を行い、通過時は Parameters を `onNamespace` へ伝搬する。active tracker は suffix をキーにするため再通知で二重登録されず、終了通知は明示 NAMESPACE_DONE または FIN / RESET 補完のどちらか 1 回になる。prefix 更新時の active namespace 再構成との接続点をコメントで示した。
- `src/session.ts` の `subscribeNamespace` の JSDoc に、NAMESPACE が Parameters を持ち再送で更新を通知することを追記した。
- テストは空 Parameters の count、複数メッセージ連結、切り詰め 3 種、未知型、重複、余剰バイト、scope 違反、再通知の callback 伝搬、FIN / NAMESPACE_DONE の終了通知が 1 回であることを検証する。PBT は Parameters を含む round-trip と scope 違反 NAMESPACE の混入を検証する。
- docs は 0925 で一括更新するため触っていない。

### 既知の制限

- 現在の draft は NAMESPACE に出現できる Parameter を定義していないため、公開 callback の Parameters は常に空配列である。非空 Parameters の end-to-end 伝搬は拡張が定義された時点で検証する。
- `onNamespace` の引数追加は公開 API の破壊的変更である (プロジェクト方針として許容)。
- NAMESPACE_DONE 後の同 suffix の NAMESPACE は再追加として扱うが、その経路の専用テストは無い。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施である。

### 残課題 (別 issue で扱う)

- prefix 更新時の active namespace 再構成 (0906)
