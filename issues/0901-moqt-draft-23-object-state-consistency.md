# 非存在と受信済み Object の矛盾を Track 全体で検出する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-object-state-consistency
- Polished: 2026-11-03

## 目的

draft 23 §2.1.2 / §12.1 は Object の Gone 状態を追加し、実 Object と Does Not Exist の両方向の矛盾を malformed track とした。Gone / Unknown は非存在の断定ではないため、同じ扱いにできない。

## 現状

- `src/session/priorGapTracking.ts` の `assertNoPriorIdGapTrackViolation` は Prior Group / Object ID Gap と実 Object の矛盾を追跡する
- `src/session/stream.ts` の `processFetchObjects` は End of Range を追跡検証の前に読み飛ばすため、FETCH で明示した非存在範囲は保存されない
- Object Status による非存在と、FETCH の Range Filter 有無に応じた暗黙の gap も、現在の Prior Gap 用追跡だけでは表現できない

## 設計方針

- Full Track Name 単位で、受信済み位置と確定した非存在範囲を突き合わせる。非存在通知の後の実 Object と、実 Object の後の非存在通知の両方を検出する
- 通常購読 / Datagram の Object Status、Prior Gap、FETCH の明示・暗黙 gap を §3.2.2 に従って扱う。フィルタによる省略を非存在と誤認しない
- Gone / Unknown / Timed-Out から実 Object を受信しても拒否しない。キャッシュを実装しないクライアントに relay のキャッシュ機構を追加しない
- 違反時はセッション全体を閉じず、既存の `cancelMalformedTrackPeers` で同じ Track の購読 / FETCH を終了する。追跡状態は利用者が無くなった時に解放する
- 範囲を Object ごとの配列へ展開せず、受信済み位置と非存在範囲は区間で保持する。0899 / 0900 が decode した範囲・終端を使う
- 長寿命 Track でも保持量を制限するため、追跡する Full Track Name は最大 1024 件とし、Track ごとの受信済み区間・非存在区間・Group 終端の記録は各最大 1024 件にする。Track 終端は 1 件を保持する。既存 Prior Gap 追跡と同様に、超過時は最も古い記録 / Track から破棄し、破棄した情報を非存在や存在の根拠にしない。矛盾検出は保持中の履歴について保証し、破棄した履歴との矛盾は検出できない制限をコメントに明記する

## 完了条件

- すべての非存在通知手段と実 Object の前後順、別購読 / FETCH をまたぐ矛盾を検証する
- Range Filter による省略と Gone / Unknown / Timed-Out の後の到着は受理する
- 異なる Full Track Name と同じ ID を混同しない
- 広い範囲を展開せず、分断した区間が増えても保持件数の上限を超えない。最古の記録の破棄後に誤った矛盾判定をせず、検出範囲が保持中の履歴に限られることを検証する
- 終了後に追跡状態が残らない

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §2.1.2 / §3.2.2 / §10.8 / §10.9 / §12.1
- `src/session/priorGapTracking.ts`、`src/session/stream.ts`、`src/session/incoming.ts`、`src/session/bidi.ts`

## 解決方法

{未着手}
