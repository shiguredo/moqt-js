# relay 経由の SUBSCRIBE_TRACKS で結果 PUBLISH の Object が配送されない

- Created: 2026-11-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-relay-subscribe-tracks-object-delivery
- Polished: 2026-11-16

## 目的

relay 経由で publisher が受信する SUBSCRIBE_TRACKS の結果 PUBLISH に Object が流れない原因を確定し、リレー側・クライアント側のどちらで解消するかを決める。

## 現状

2026-11-15 に実リレーで確認した事実である (単一リレーと 2 台のリレーの両方で同じ)。

- relay は downstream の SUBSCRIBE_TRACKS を上流の publisher へ転送する
- publisher はそれを受信して受理し、catalog と video の PUBLISH を返す
- downstream の subscriber は両方の PUBLISH を受信する
- その後 relay は同じ video Track について通常の SUBSCRIBE を上流の publisher へ送る
- moqt-js は受信した SUBSCRIBE を REQUEST_ERROR (NOT_SUPPORTED) で拒否する (publisher ロールの SUBSCRIBE 受信は未実装である)
- relay は PUBLISH 購読を打ち切り、publisher のセッションは `failed to close stream after PUBLISH_DONE: Cannot close a ERRORED writable stream` で閉じる (この close 失敗の昇格は 0966 で修正する)
- 結果として、SUBSCRIBE_TRACKS の購読へ映像 Object が流れない

draft-ietf-moq-transport-23 §7.7 は「Relays MUST send at least one SUBSCRIBE to each matching publisher.」と定める。CODEBASE.md は「クライアントでのみ利用すること (MOQT の publisher / subscriber として接続する用途だけを対象とする)」「クライアント以外での用途の実装は不要であること (サーバー / リレーとしての動作は実装しない)」と定める。publisher はクライアントであり、publisher ロールとして SUBSCRIBE を受けるため、受信 SUBSCRIBE の処理は方針外ではなく未実装である。0960 は同じ publisher ロールの SUBSCRIBE_TRACKS を受信して処理しており、CODEBASE.md の方針変更なしで実装している。

## 設計方針

次のどれを採るかを決める。

1. リレー側で、SUBSCRIBE_TRACKS の結果 PUBLISH の購読だけで Object を配送できるようにする (relay の実装へフィードバックする)
2. 受信 SUBSCRIBE を実装しないまま、relay 経由の SUBSCRIBE_TRACKS は PUBLISH の受理までを対応範囲とし、docs に制限として明記する。docs/IMPLEMENTATION_STATUS.md の既存記述を制限として明確化し、「クライアント専用のため」という理由も publisher ロールの SUBSCRIBE 受信が未実装であることに改める。docs/LOW_LEVEL_API.md と docs/HIGH_LEVEL_API.md の SUBSCRIBE_TRACKS の節にも、relay が上流へ SUBSCRIBE を送る構成では結果 PUBLISH の Object が届かない場合があることを書く
3. 受信 SUBSCRIBE の処理を実装する。クライアントの publisher ロールの範囲内であり、CODEBASE.md の方針変更は不要である。実装量が大きいため、この issue では決定と実装 issue の起票までを行い、実装はその issue で行う

あわせて、上記の `failed to close stream after PUBLISH_DONE` の切り分けと、セッションを閉じない修正は 0966 で扱う。0966 の修正後も relay による PUBLISH 購読の打ち切りは残るため、0962 は Object 不達の解消方法だけを決める。

## 完了条件

- 1 から 3 のどれを採るかを決定し、根拠を残す
- 決定に必要な修正 (relay 側へのフィードバック、docs の制限記載、実装 issue の起票のいずれか) を反映する
- 決定に応じて `tests/e2e/relay/subscribe-tracks.spec.ts` の assert とコメントを更新する。Object 配送を対応範囲にする場合は Object の受信を assert し、対応範囲にしない場合は assert しない理由をコメントに残す。実装を別 issue にする場合は、その issue の完了条件に Object の受信の assert を含める。テストのコメントから issue 番号への参照を外す

## 参照

- `tests/e2e/relay/subscribe-tracks.spec.ts`
- `src/session/incomingSubscribeTracks.ts` / `src/session/incoming.ts`
- `src/session/publish.ts` (0966 の close 失敗の昇格)
- `refs/moq/draft-ietf-moq-transport-23.txt` §3.6 / §7.7 / §9.8 / §9.19.21
- `CODEBASE.md` (クライアントの publisher / subscriber ロールと、サーバー / リレーを実装しない方針)
- `docs/IMPLEMENTATION_STATUS.md` / `docs/LOW_LEVEL_API.md` / `docs/HIGH_LEVEL_API.md` (制限の記載先)
- 関連 issue: 0960 (publisher 側 SUBSCRIBE_TRACKS の実装)、0961 (実機 E2E)、0966 (PUBLISH_DONE 後の close 失敗)

## 解決方法

{未着手}

## 2026-11-16 の確定 (追記)

- 結果 PUBLISH で同じ (Group, Object) が異なる Subgroup ID で送られていた問題は closed 0967 で修正した (Track 全体で Subgroup ID / Priority を共有し、途中参加は EXPLICIT_Subgroup で明示する)。修正後は devtools publisher + SUBSCRIBE_TRACKS の購読で MALFORMED_TRACK にならず、映像が復号されることを実リレーで確認している
- PUBLISH_DONE 後の close 失敗で publisher セッション全体が閉じる問題は closed 0966 で修正した
- 残るのは、relay が §7.7 の MUST で送る上流 SUBSCRIBE に moqt-js がクライアント専用として REQUEST_ERROR (NOT_SUPPORTED) を返すことである。relay がこの拒否の後に PUBLISH 購読を打ち切る挙動は実測しており、継続配信の可否はこの経路の扱い (受信 SUBSCRIBE 対応 / クライアント専用のまま制限として明記 / relay 側へのフィードバック) の決定に依存する
- 完了条件に「方針の決定」を加え、実装する場合は CODEBASE.md のクライアント専用方針の変更を伴うことを明記する
