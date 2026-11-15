# relay 経由の SUBSCRIBE_TRACKS で結果 PUBLISH の Object が配送されない

- Created: 2026-11-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-relay-subscribe-tracks-object-delivery
- Polished: {YYYY-MM-DD}

## 目的

relay 経由で publisher が受信する SUBSCRIBE_TRACKS の結果 PUBLISH に Object が流れない原因を確定し、リレー側・クライアント側のどちらで解消するかを決める。

## 現状

2026-11-15 に実リレーで確認した事実である (単一リレーと 2 台のリレーの両方で同じ)。

- relay は downstream の SUBSCRIBE_TRACKS を上流の publisher へ転送する
- publisher はそれを受信して受理し、catalog と video の PUBLISH を返す
- downstream の subscriber は両方の PUBLISH を受信する
- その後 relay は同じ video Track について通常の SUBSCRIBE を上流の publisher へ送る
- moqt-js はクライアント専用であり、受信した SUBSCRIBE を REQUEST_ERROR (NOT_SUPPORTED) で拒否する
- relay は PUBLISH 購読を打ち切り、publisher のセッションは `failed to close stream after PUBLISH_DONE: Cannot close a ERRORED writable stream` で閉じる
- 結果として、SUBSCRIBE_TRACKS の購読へ映像 Object が流れない

draft-ietf-moq-transport-23 §7.7 は「Relays MUST send at least one SUBSCRIBE to each matching publisher.」と定める。一方、CODEBASE.md は「クライアントでのみ利用すること」「クライアント以外での用途の実装は不要」と定めており、受信 SUBSCRIBE の処理は現行の方針外である。

## 設計方針

次のどれを採るかを決める。

1. リレー側で、SUBSCRIBE_TRACKS の結果 PUBLISH の購読だけで Object を配送できるようにする (relay の実装へフィードバックする)
2. クライアント専用のまま、relay 経由の SUBSCRIBE_TRACKS は PUBLISH の受理までを対応範囲とし、docs に制限として明記する
3. 受信 SUBSCRIBE の処理を実装する。ただし CODEBASE.md の方針変更を伴うため、単独では決めない

あわせて、上記の `failed to close stream after PUBLISH_DONE` が moqt-js 側の後始末の不具合か、リレーの打ち切りに対する想定内の失敗かを切り分ける。

## 完了条件

- 1 から 3 のどれを採るかを決定し、根拠を残す
- 決定に必要な修正 (relay 側へのフィードバック、docs の制限記載、方針変更の issue 化のいずれか) を反映する
- 実リレーで確認できる範囲を `tests/e2e/relay/subscribe-tracks.spec.ts` の assert と一致させる

## 参照

- `tests/e2e/relay/subscribe-tracks.spec.ts`
- `src/session/incomingSubscribeTracks.ts` / `src/session/incoming.ts`
- draft-ietf-moq-transport-23 §3.6 / §7.7 / §9.8 / §9.19.21
- CODEBASE.md (クライアント専用の方針)
- 関連 issue: 0960 (publisher 側 SUBSCRIBE_TRACKS の実装)、0961 (実機 E2E)

## 解決方法

{未着手}
