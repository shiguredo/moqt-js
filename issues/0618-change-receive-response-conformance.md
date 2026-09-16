# 受信応答の判定を仕様に合わせる

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/change-receive-response-conformance
- Polished: {YYYY-MM-DD}

## 目的

受信時の検証・応答に、draft-ietf-moq-transport-21 の記述と食い違う箇所が 4 つ残っている。相互運用に影響するものと、解釈を決めてコードとコメントに固定すべきものをまとめて解消する。

## 現状

- TRACK_STATUS_OK で EXPIRES を受信するとセッションを閉じる。§9.13 は「SUBSCRIBE_OK で設定したのと同じ parameters と Track Properties」を返すと定め、§9.20.17 は EXPIRES が SUBSCRIBE_OK に出現可能とするため、字義通りに実装した publisher と相互運用できない。逆に §9.20.17 の出現先一覧に TRACK_STATUS_OK はない
- `.session` および `.` 単体を参照する未対応リクエストに NOT_SUPPORTED を返す。§6.5 と §2.4.2 は DOES_NOT_EXIST での拒否を MUST とする。受信 PUBLISH 経路は実装済みで、未対応 6 種の経路だけが非対称
- 確立後の 2 通目の REQUEST_OK を黙殺する。§3.1 は「応答は 1 通であり、2 通以上受信したら protocol error で閉じる SHOULD」を定め、§4.2 の namespace 系ループは閉じる実装になっている
- リクエストストリーム上の GOAWAY 受信後、subscribe ロールで届いた REQUEST_UPDATE を無視する。§9.5 の MUST からは逸脱するが、§6.4.2.2 の FIN 規則と衝突するため、意図的な逸脱として残している

draft-ietf-moq-transport-21 §6.5:

> An endpoint that receives a request for an unrecognized session-level track or namespace MUST reject it with REQUEST_ERROR using error code DOES_NOT_EXIST rather than passing it to the Application.

## 設計方針

- TRACK_STATUS_OK は §9.20.17 の出現先一覧を根拠に現状維持とし、その解釈をコードコメントに明記する。相互運用を優先する場合は EXPIRES を許容する
- `.session` と `.` 単体は、未対応リクエスト経路でも先頭の Track Namespace を読んで判定し、該当時に DOES_NOT_EXIST を返す。デコードできない場合のみ NOT_SUPPORTED を維持する
- 2 通目 REQUEST_OK は「pending がなく、自 endpoint が REQUEST_UPDATE を送っていない」場合に限り PROTOCOL_VIOLATION とする (§9.5 が認める coalescing は失敗した更新を 1 通の REQUEST_ERROR にまとめる規定であり、REQUEST_OK の重複受信を許さない)。ただし GOAWAY 受信済みの request stream は除く。GOAWAY 受信時に未応答の REQUEST_UPDATE は reject 済みで pendingRequestUpdate から削除されるため (§9.2)、その後届く REQUEST_OK は削除済みの更新への正当な応答でありうる
- GOAWAY 後の subscribe ロールは、閉じる側に寄せるか逸脱を明記して維持するかを決める

## 完了条件

- 4 件それぞれの扱いが決定され、実装とテストが決定に沿う
- 決定理由がコードコメントに残る
- TRACK_STATUS_OK の EXPIRES について、採用しなかった側の解釈とその理由がコメントに残る
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §2.4.2 (Reserved Namespaces)
- draft-ietf-moq-transport-21 §3.1 (Subscriptions: exactly one 応答)
- draft-ietf-moq-transport-21 §3.2.1 (Fetch State Management: exactly one FETCH_OK)
- draft-ietf-moq-transport-21 §4.2 (Publishing Namespaces: 2 通目で protocol error)
- draft-ietf-moq-transport-21 §6.4.2.2 (Graceful Request Stream Closure)
- draft-ietf-moq-transport-21 §6.5 (Session-Level Tracks and Namespaces)
- draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE)
- draft-ietf-moq-transport-21 §9.13 (TRACK_STATUS)
- draft-ietf-moq-transport-21 §9.20.17 (EXPIRES Parameter)
