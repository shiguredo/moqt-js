# GOAWAY ハンドリング時にストリームリソースが解放されない

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

`startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop` の GOAWAY ハンドリングで、subscription の writer.close() / reader.cancel() / Map.delete() が行われず、WebTransport ストリームがリークする可能性がある。

## 優先度根拠

長時間稼働時に WebTransport ストリームのリソースリークが発生する。

## 現状

`src/session.ts:1882-1893` (`startNamespaceStreamLoop` GOAWAY):
- `callbacks.error()` と `reject()` は呼ばれるが `namespaceSubscriptions.delete()` やストリームの close がない

`src/session.ts:2114-2140` (`startTracksStreamLoop` GOAWAY):
- 同様に `tracksSubscriptions.delete()` やストリームの close がない

`src/session.ts:2374-2388` (`startNamespacePublicationStreamLoop` GOAWAY):
- 同様に `namespacePublications.delete()` やストリームの close がない

## 設計方針

- GOAWAY ハンドリング時に以下を行う:
  1. `writer.close()` (存在する場合)
  2. `reader.cancel()` (存在する場合)
  3. 該当する Map からエントリを delete
- または GOAWAY 受信時に `closeWithError` でセッション全体を閉じる (全リクエストのクリーンアップが走る)

## 完了条件

- GOAWAY 受信時にストリームリソースが適切に解放される
- テストが追加されている
