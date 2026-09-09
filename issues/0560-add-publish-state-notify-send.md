# PUBLISH_STATE_NOTIFY の送信を実装する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/add-publish-state-notify-send
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §9.10 は、publisher が購読状態の変化を PUBLISH_STATE_NOTIFY で通知し、既知なら LARGEST_OBJECT を必ず含める MUST を定める。現状は受信ハンドラとエンコーダのみで送信経路がなく、EXPIRES 失効等の状態変化を購読者へ通知できない。

## 現状

- `src/message/session.ts` の `encodePublishStateNotifyPayload()` はエクスポートされているが、送信経路から呼ばれていない。
- `src/session/bidi.ts` の `bidiHandlePublishStateNotify` は受信のみ。
- publisher 側の状態変化 (EXPIRES 失効等) を通知する経路がない。

## 設計方針

1. publisher の購読状態変化時に PUBLISH_STATE_NOTIFY を購読の双方向ストリームへ送信する。
2. 既知なら LARGEST_OBJECT を含める (§9.20.18)。
3. 許可パラメータ (LARGEST_OBJECT / FORWARD / LOCATION_FILTER) のみを載せる。
4. 送信タイミング (EXPIRES 失効等) と重複送信の抑止は実装時に確定する。

## 完了条件

- 購読状態変化時に PUBLISH_STATE_NOTIFY が送信される。
- LARGEST_OBJECT が必要時に含まれる。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §9.10 / §9.20.18
- 監査: issue 0558 の適合監査 (A-2)
- 関連: `issues/0552-update-publish-state-notify-filter-compare.md`
