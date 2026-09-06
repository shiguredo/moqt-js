# Publisher 送信側の status / payload 整合と END_OF_TRACK 後送信のガード欠落

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-publisher-send-guard
- Polished: 2026-09-06

## 目的

非 NORMAL 時の非空 payload や `END_OF_TRACK` 後の送信を呼び出し側で検出できず、失敗の検出が遅延する。意図的決定の `0320` (検証しない) を覆し、送信前に検証する必要がある。

## 現状

- `src/publisher.ts` の `sendObject` のガードは `closed` のみで、status / payload 規則を検証しない。`0320` は `END_OF_TRACK` 後の後続送信を検証しないことを意図的に決定した (注釈に制約を明記するのみ)。本 issue はその決定を覆す。
- payload 空規則の MUST 根拠は §11.2.1.1 である。`END_OF_TRACK` 後禁止の MUST 根拠は同節になく、`SendObjectParams` 注釈の解釈である (同節は「以降の object は存在しない」という意味論のみ)。
- 受信側 (`src/dataStream.ts`) は非 NORMAL + 非空 payload を `ProtocolViolationError` で拒否し、送信側の `encodeObjectFields` も queue 内で事前に throw するため線路上には出ない。ただし queue の `.catch()` (`handleError` 変換) に吸収され、呼び出し側の `await` には届かない。本対応は呼び出し側同期検出の fail-fast 化である。
- `END_OF_TRACK` 送信済みを記録する状態は `PublisherImpl` になく、追加が必要である。`sendDatagram` の `SendDatagramParams` に status はないが、同一 track の `sendObject` / `sendDatagram` 併用は許されるため `END_OF_TRACK` 後禁止は両方に適用する。

## 設計方針

1. `PublisherImpl.sendObject` で委譲前に同期検証し、違反は `ProtocolViolationError` を `throw` する (queue 吸収を避ける。伝播方式は `0471` の見直しに合わせる)。検証項目は status / payload 組み合わせ (`NORMAL` + 空は成功、`status` 省略は `NORMAL`、非 `NORMAL` + 非空 payload と properties 付き非 `NORMAL` は失敗) とする。
2. `END_OF_TRACK` 送信済み記録の新規状態を追加し (送信成功時にセット、`sendObject` / `sendDatagram` 共有)、記録後の両 API 呼び出しを `throw` する。
3. 境界値の単体テストを追加する (上記組み合わせと 2 回目呼び出し)。

## 完了条件

- 不正な status / payload 組み合わせと `END_OF_TRACK` 後の送信が、呼び出し側への同期 `throw` (`ProtocolViolationError`) で失敗すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.2.1.1
- `0320` (検証しない意図的決定。本 issue は覆す)
- `0471` (throw 伝播の見直し。本 issue は追随する)
- `0504` (送信ガードの振る舞い変更の順序調整先)
