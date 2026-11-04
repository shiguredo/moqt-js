# 非存在と受信済み Object の矛盾を Track 全体で検出する

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
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

- `src/session/objectStateTracking.ts` を新設し、Full Track Name 単位で受信済み位置と確定した非存在範囲を Location の閉区間 (`TrackLocationRange`) として保持するようにした。区間は隣接・重複を 1 件へ統合し、2^64-1 を含む広い範囲でも Object ごとの配列へ展開しない。
- FETCH 応答の traversal order (Ascending / Descending、Descending の Group またぎは `{End Group, 0}` 始点・`{Start Group, 2^64-1}` 終点) を区間に分解し、要求範囲の下限 / 上限でクランプする `buildFetchTraversalGapRanges` を追加した。暗黙 gap・End of Non-Existent Range・FIN 末尾 gap を同じ関数で扱う。
- 前後両方向の矛盾検出 (§12.1 条件 10) を実装した。受信時は保存済み非存在範囲内の Object を `MalformedTrackError` とし、通知時は非存在通知が他経路で受信済みの区間と交差すれば `MalformedTrackError` とする。malformed と判定した Object は受信状態に登録しない。判定は Full Track Name キーを共有するため、別購読 / 別 Subgroup / Datagram / FETCH をまたいで働く。
- 非存在通知手段を §3.2.2 に従って扱う。Object Status `END_OF_GROUP` / `END_OF_TRACK` (Subgroup・Datagram)、Prior Group ID Gap / Prior Object ID Gap、FETCH の End of Group / End of Track indicator、FETCH の End of Non-Existent Range (0x8C。Range Filter の有無や fill fetch でも明示通知として記録する)、Subgroup Header の END_OF_GROUP ビットと FIN で確定する Group 最終 Object、要求範囲が確定している通常 FETCH の暗黙 gap (先頭 / エントリー間 / FIN 末尾)。Range Filter を含む要求のマークされていない gap は Unknown として記録しない。
- Gone / Unknown / Timed-Out は非存在の断定ではないため (§2.1.2)、非存在区間として記録せず、後の実 Object を受理する。
- 違反時はセッション全体を閉じず、既存の `cancelMalformedTrackPeers` で同じ Track の購読 / FETCH を終了する。追跡状態は既存の `priorGapTrackingByTrack` に同居させ、購読 / FETCH が尽きた時点で解放する。
- 保持量の上限を設けた。Track 1024 件、Track ごとの受信済み区間 / 非存在区間 / Group 終端は各 1024 件、Track 終端は 1 件。超過時は最も古い記録 / Track から破棄し、破棄した情報を存在 / 非存在の根拠にしない (誤検出は生まず、検出漏れのみ)。破棄による検出範囲の制限をコメントに明記した。
- `docs/` は今回のスコープ外のため更新していない。
- テストは区間の統合・境界・上限破棄、Descending の区間分解と要求範囲クランプ、全通知手段 × 実 Object の前後両方向、Range Filter による省略の受理、Gone / Unknown / Timed-Out の後の到着受理、別 Track の非混同、FIN 末尾 gap の実ストリーム統合、Subgroup Header の END_OF_GROUP ビット + FIN の統合 (4 ケース)、終了後の状態残留なしを検証する。

### 既知の制限

- fill fetch は fill 範囲を保持していないため、暗黙 gap を推論しない。明示 0x8C は直前のエントリーから復号位置までを記録するが、先頭エントリーが 0x8C の場合は起点が要求範囲に依存するため記録しない。
- Subgroup Header の END_OF_GROUP ビットは FIN を観測して初めて確定するため、データストリーム終了時にのみ記録する。
- 非存在通知の後の実 Object のうち Gone / Unknown / Timed-Out は受理する (非存在の断定ではない)。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施であり、暗黙 gap の解釈は実リレー確認時に再確認する。

### 残課題 (別 issue で扱う)

- セッションエラー分類の移行 (0902)
