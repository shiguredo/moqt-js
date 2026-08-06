# PUBLISH_OK 後にピアが FIN すると PUBLISH_DONE が送信されない

- Priority: High
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-publish-done-skipped-after-peer-fin
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §3.3.2 の MUST 要件「Established subscription の publisher は FIN を送る前に PUBLISH_DONE を送信しなければならない」を満たす。現在はピアが PUBLISH_OK 後に送信方向を FIN すると、`publisher.done()` が PUBLISH_DONE と FIN を静かにスキップし、ピアは Track 終了を永遠に検知できない。

## 優先度根拠

準拠ピアとの実運用で確実に発現するライフサイクルバグ。§3.3.2 では responder が応答後に FIN を送ることを認めており、ピアが PUBLISH_OK 後に FIN を送るのは正常な動作である。このとき moqt-js 側の PUBLISH_DONE 送信が消失し、サブスクライバ側で Track が終了しない。High。

## 現状

- `src/session/bidi.ts:667` の `if (done) break;` でピアの FIN を検出すると読み取りループを抜け、`finally` ブロック (`bidi.ts:840-851`) で `session.requestStreams.delete(requestId)` が実行される。
- その後 `publisher.done()` → `publishSendPublishDone` (`src/session/publish.ts:343`) は `session.requestStreams.get(requestId)` が `undefined` のため、PUBLISH_DONE 送信と `writer.close()` を静かにスキップする。
- 結果として §3.3.2 の「the publisher of an Established subscription MUST send PUBLISH_DONE, before sending a FIN」を満たせない。

## 設計方針

- PUBLISH_OK を受信済みの publish ストリームでは、ピアの送信方向 FIN を「リクエストの失敗」として扱わず、publisher 側の送信方向 (PUBLISH_DONE + FIN) を継続できるようにする。
- `requestStreams` からの削除タイミングを publisher の `done()` 完了後まで遅らせる、または PUBLISH_DONE 送信に必要な writer を別途保持する。
- ピアが PUBLISH_DONE を受信する前にストリームが閉じないことを保証するテストを追加する。

## 完了条件

- PUBLISH_OK 受信後にピアが送信方向を FIN しても、`publisher.done()` で PUBLISH_DONE が送信され、ストリームが FIN で閉じられること。
- 上記シナリオを再現するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.2 (Graceful Request Stream Closure)
- draft-ietf-moq-transport-19 §10.11 (PUBLISH_DONE)

## 解決方法

未着手。
