# 送信側で同一 Parameter Type の重複を拒否していない

- Created: 2026-09-15
- Completed: 2026-09-17
- Branch: feature/fix-duplicate-message-parameter-send
- Polished: 2026-09-15

## 目的

draft-ietf-moq-transport-21 §9.20 は Senders MUST NOT repeat the same Parameter Type を定めるが、`encodeParameters` は Type 昇順のソートのみで重複を検査しない。raw パラメータと型付きオプションを併用すると同一 Type が 2 件載ったワイヤを生成する。同一節は受信側に「重複があれば PROTOCOL_VIOLATION でセッションを閉じる」SHOULD も定めており、`decodeParameters` はこれを実装済みのため、生成したワイヤはピアの実装によってセッション終了を招く。

## 現状

- `encodeParameters` (`src/message/parameter/messageParameter.ts`) は同一 Type を許容してそのまま直列化する
- `bidiSendRequestUpdate` (`src/session/bidi.ts`) は FILL_PARAMETERS と NEW_GROUP_REQUEST に個別の重複ガードを持つが、FORWARD にはない
- 再現手順: `subscriber.update({ parameters: [{ type: 0x10, value: ... }], forward: true })` とすると、`assertParametersAllowedForSend` は FORWARD を許可し、型付き FORWARD がさらに push されるため 0x10 が 2 件載る。実際に REQUEST_UPDATE が 1 件書かれ、パラメータ数 2 のワイヤ (`0x10` が値 1 と値 0 の 2 件) が生成されることを確認済み
- 受信側の `decodeParameters` は重複を検出して PROTOCOL_VIOLATION にするため、送受信で非対称になっている (受信側の検出は §9.20 の SHOULD、送信側の禁止は同節の MUST NOT)

draft-ietf-moq-transport-21 §9.20:

> Senders MUST NOT repeat the same Parameter Type in a message unless the parameter definition explicitly allows multiple instances of that type to be sent in a single message. Receivers SHOULD check that there are no unexpected duplicate parameters and close the session with PROTOCOL_VIOLATION if found.

## 設計方針

- `decodeParameters` の反復許可判定を共通関数 `isRepeatableMessageParameterType(paramType)` として `messageParameter.ts` から抽出し、`decodeParameters` と `encodeParameters` の両方から使う
- 抽出した共通関数を使い、`encodeParameters` で型ごとの出現回数を数えて重複があれば throw する。受信側の `ProtocolViolationError` はプロトコル違反の通知、送信側の throw はローカル API 誤用の通知であり、送信側は汎用 `Error` を使う (`assertParametersAllowedForSend` と同じ扱い)
- 反復が許可される型は受信側と同じ型レベルの判定に限定する。AUTHORIZATION_TOKEN (0x03) と Range Filter (0x25-0x29) は型として反復可とし、それ以外の型は同一メッセージ内で 1 件に限る。判定・検査の本体は `assertNoDuplicateMessageParameterTypes(params)` として `messageParameter.ts` に置き、規則を 2 箇所に書かない。重複時のエラーは汎用 `Error` とし、カスタムメッセージ用の引数は設けない
- エンコーダはワイヤのバイト列しか見えず、デコード値を持たない。このため §8.9 の「Alias 解決後の Token Type と Token Value の組が一意」と §3.3.2 の「Parameter Type と SetID と Property Type の組み合わせが一意」という値レベルの規則は本 issue の対象外とする。型付き Range Filter 指定の組み合わせ重複は `validateRangeFilterSpecs` (`src/session/params.ts`) が送信時に拒否済みであり、その挙動を変えない。生パラメータ経路の Range Filter は同関数を通らず、`encodeParameters` の型レベルの除外により受信側 (`validateRangeFilterCombination`) だけが拒否する非対称が残るが、これも値レベルの規則として別 issue の対象とする。AUTHORIZATION_TOKEN の値レベルの重複も受信側で検出しておらず、既存の送信経路も生成しないため同様に別 issue の対象とする
- 既存の個別ガード (FILL_PARAMETERS / NEW_GROUP_REQUEST) は削除も書き換えもしない。既存ガードは FILL_PARAMETERS が「raw 配列内の重複」ではなく型付き fill も含めた合算を見る点、NEW_GROUP_REQUEST が生パラメータとオプションの合算を見る点で、`encodeParameters` からは参照できない情報を使っており、エントリ残留を防ぐ位置と例外型 (`InvalidFilterError` / 汎用 `Error`) とメッセージを既存テストが固定しているため。共通検査へ渡す配列を個別ガード側で合成する必要はなく、両者は役割が重ならない
- 個別ガードを持たない型 (FORWARD など) と、raw パラメータ同士の重複を漏れなく拒否するため、`bidiSendRequestUpdate` が `parameters` 配列へ型付きパラメータを積み終えた後、`encodeRequestUpdatePayload` を呼ぶ直前に `assertNoDuplicateMessageParameterTypes(parameters)` を 1 回呼ぶ。この時点の `parameters` は `options.parameters` と、その経路が追加する FORWARD / Range Filters / FILL_PARAMETERS / NEW_GROUP_REQUEST / AUTHORIZATION_TOKEN をすべて含む
- `encodeParameters` の内部にも同じ `assertNoDuplicateMessageParameterTypes` を追加し、全メッセージのエンコード経路でこの規則を適用する。上記の 1 回の呼び出しは、個別ガードを持たない型を `pendingRequestUpdate` と `fillFetchTargets` への登録前に拒否するためのもの。`encodeParameters` 内の検査は、`encodeRequestUpdatePayload` に到達するすべての制御メッセージに対する保証として残す

## 完了条件

- raw と型付きの合算で同一 Type が 2 件以上になる REQUEST_UPDATE が、REQUEST_UPDATE の送信前に拒否される。送信バイトが 0 で、`pendingRequestUpdate` と `fillFetchTargets` にエントリが残らない
- FILL_PARAMETERS と NEW_GROUP_REQUEST の既存の個別ガードのメッセージと例外型 (`InvalidFilterError` と汎用 `Error`) は変わらない。FORWARD など他の型の重複は `encodeParameters` の共通検査で拒否される
- AUTHORIZATION_TOKEN (0x03) と Range Filter (0x25-0x29) は型レベルの反復が引き続き許可される
- 生パラメータを受け取る公開オプションは `RequestUpdateOptions.parameters` (`src/subscriber.ts`) だけであり、他の制御メッセージは型付きオプションから構築されるため重複を生成しない。`encodeParameters` 内の検査により、他の制御メッセージにも同じ規則が適用される
- テストがある。次を検証する: (1) `assertNoDuplicateMessageParameterTypes` が非反復型の重複を拒否し、反復型 (0x03 / 0x25-0x29) の重複を許可する単体テスト、(2) `subscriber.update({ parameters: [{ type: 0x10, value: ... }], forward: true })` が送信前に拒否され `pendingRequestUpdate` と `fillFetchTargets` にエントリが残らない統合テスト、(3) `encodeParameters` が同一 Type 2 件で throw する単体テスト、(4) 既存の FILL_PARAMETERS / NEW_GROUP_REQUEST の個別ガードのテストが変更なしで通ること
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.20 (Control Message Parameters)
- draft-ietf-moq-transport-21 §3.3.2 (Range Filters)
- draft-ietf-moq-transport-21 §8.9 (Authorization Token Compression)

## 解決方法

- `src/message/parameter/messageParameter.ts` の `decodeParameters` に埋まっていた反復許可判定を
  `isRepeatableMessageParameterType` として抽出し、送信側と共通化した (AUTHORIZATION_TOKEN 0x03 と Range Filter 0x25-0x29 のみ true)
- 同じファイルに `assertNoDuplicateMessageParameterTypes(params)` を追加した。反復可能でない型が 2 件以上ある場合は
  汎用 `Error` を throw する (送信側はローカル API の誤用、受信側は `ProtocolViolationError` として区別する)
- `encodeParameters` の先頭で同関数を呼び、全制御メッセージのエンコード経路でこの規則を適用する
- `src/session/bidi.ts` の `bidiSendRequestUpdate` (subscription 系 / namespace 系) で、型付きパラメータを積み終えた後
  `encodeRequestUpdatePayload` を呼ぶ前に同関数を呼ぶ。`pendingRequestUpdate` / `fillFetchTargets` への登録より前に
  失敗させるため、エンコード直前ではなくこの位置に置いた
- FILL_PARAMETERS / NEW_GROUP_REQUEST の既存の個別ガードは、型付き fill や raw 配列との合算を見る位置・例外型・メッセージを
  既存テストが固定しているため変更していない
- `src/message/parameter.ts` / `src/message/index.ts` に 2 関数を再エクスポートした

テストは `src/message/parameter.test.ts` に 3 本 (重複拒否、反復可能な型の許可、`isRepeatableMessageParameterType` の判定)、
`src/session/bidiRequestUpdateDuplicateParameter.test.ts` に 2 本 (raw FORWARD と forward オプションの合算が送信前に拒否され
送信バイト 0・エントリ残留なし、重複が無ければ従来どおり送信される) を追加した。

検証は `pnpm exec tsc --noEmit` / `pnpm exec vp check` / `pnpm test --run` (2250 passed) の通過で確認した。
