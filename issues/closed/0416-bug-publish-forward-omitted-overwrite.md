# role=publish ハンドラが FORWARD 省略の REQUEST_UPDATE で Forward State を true に上書きする

- Priority: Low
- Created: 2026-08-12
- Completed: 2026-08-25
- Branch: feature/fix-publish-forward-omitted-overwrite
- Polished: 2026-08-20

## 目的

draft-ietf-moq-transport-19 §10.2.17 の「If the parameter is omitted from REQUEST_UPDATE, the value for the subscription remains unchanged」に従い、FORWARD が省略された REQUEST_UPDATE を受信した場合に Forward State を変更しないよう修正する。

## 現状

- `bidiReadRequestStreamMessages` の role=publish 分岐 (`src/session/bidi.ts`) は、受信 REQUEST_UPDATE のパラメータに対して `extractForwardState(decoded.parameters)` を無条件適用し `publisher.setForwardState(forwardState)` を呼ぶ。
- `extractForwardState` (`src/session/params.ts`) は FORWARD パラメータが無い場合にデフォルト値 true を返すため、FORWARD 省略の REQUEST_UPDATE を受信すると Forward State が true に上書きされる。
- これは §10.2.17 の「REQUEST_UPDATE で省略時は不変」に反する。moqt-js の `PublisherImpl` 自体は Forward State による送信ガードを持たないため、実害はアプリが `forwardState` (`onForwardStateChange`) を購読して送信制御を行う場合に限定される (アプリが FORWARD=0 を受けて送信を止めた後、パラメータ無しの REQUEST_UPDATE が届くと送信が再開されてしまう)。
- 同じ問題の受信 PUBLISH ストリーム側 (ケース 1、`bidiHandlePublishRequestUpdate`) は issue 0377 で「FORWARD パラメータが存在する場合のみ反映」に修正済みであり、role=publish ハンドラと非対称。
- 変更対象ファイル: `src/session/bidi.ts` (`bidiReadRequestStreamMessages` の role=publish 分岐)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- role=publish 分岐で FORWARD パラメータが存在する場合のみ `publisher.setForwardState` を呼ぶ (省略時は不変)。判定は FORWARD パラメータの存在チェック + `extractForwardState` の組み合わせとし、`bidiHandlePublishRequestUpdate` の実装 (issue 0377) と同パターンに揃える。なお 0377 の同パターンは「FORWARD と他の文脈限定パラメータが混合した REQUEST_UPDATE はメッセージ単位で全体拒否する」も含むが、role=publish 分岐は現状、FORWARD 以外の文脈限定パラメータを REQUEST_OK + accept-then-ignore しており (不正な Range Filter は INVALID_FILTER で拒否される点を除く)、この全体拒否の適用有無は本 issue のスコープ外とする (0377 との非対称は残る)。
- `extractForwardState` 自体のデフォルト true 動作は変更しない (PUBLISH / PUBLISH_OK / SUBSCRIBE 等、省略時デフォルト 1 が正しい他メッセージでの使用に影響するため)。
- 実装順序: open issue 0409 (同一分岐のデコード失敗処理) を先に実装する (0409 側もその旨を明記)。0409 が完了条件「必要に応じて FORWARD 反映のアサーションを追加する」を満たすために FORWARD 反映テストを追加した場合、そのテストは「FORWARD 省略でも反映される」旧挙動を期待している可能性があるため、本 issue 実装時に 0409 で追加された FORWARD 反映アサーションを本 issue の実装に合わせて更新する。

## 完了条件

- FORWARD 省略の REQUEST_UPDATE を受信した場合、`publisher.forwardState` が変化しないこと。
- FORWARD を含む REQUEST_UPDATE を受信した場合、従来どおり反映されること。
- 上記を検証するテストがあること (0377 / 0409 と同じ実 W3C ストリーム注入方式。role=publish 側の FORWARD 反映テストは現状存在しないため追加が必要。0409 を先に実装した場合は 0409 で追加された FORWARD 反映アサーションを本 issue の実装に合わせて更新する)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.2.17 (FORWARD Parameter)
- draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE / 「If a parameter previously set on the request is not present in REQUEST_UPDATE, its value remains unchanged.」)
- 関連: `issues/closed/0377-moqt-draft-19-publish-forward-param-not-applied.md`（受信 PUBLISH 側の FORWARD 反映修正。role=publish 側は別 issue として切り出された）
- 関連: `issues/0409-bug-publish-stream-request-update-decode-failure.md`（同一分岐のデコード失敗処理を変更対象とする。本 issue は 0409 の後に実装する）

## 解決方法

- `src/session/bidi.ts` (`bidiReadRequestStreamMessages` の role=publish REQUEST_UPDATE 分岐): FORWARD パラメータが存在する場合のみ `publisher.setForwardState(extractForwardState(...))` を呼ぶよう変更 (設計方針どおり、`bidiHandlePublishRequestUpdate` (受信 PUBLISH 側・0377 実装) と同パターン)。`extractForwardState` のデフォルト true 動作は変更しない (有意義な使用箇所があるため)。0377 の「全体拒否」の適用はスコープ外のため実施しない (非対称は残る)。
- テスト (`src/session/bidi.test.ts`): FORWARD 省略 → Forward State 不変 (FORWARD=0 で停止した状態からの回帰ガード)、FORWARD=1 → true 反映、の 2 本を追加 (FORWARD=0 反映は 0409 で追加済みのテストが担保。0416 実装からの 0409 側アサーション更新は不要と判断)。
- `CHANGES.md`: `[FIX]` を追記。
