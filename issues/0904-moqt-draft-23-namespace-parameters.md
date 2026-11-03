# NAMESPACE に Parameters を追加し同一 namespace の更新を通知する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-namespace-parameters
- Polished: {YYYY-MM-DD}

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

{未着手}
