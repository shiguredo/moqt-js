# 受信 SETUP の Authorization Token で DELETE / USE_ALIAS を拒否する

- Created: 2026-09-08
- Completed: 2026-09-08
- Branch: feature/fix-setup-auth-token-alias-validation
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §10.2.2 は「If a server receives Alias Type DELETE (0x0) or USE_ALIAS (0x2) in a SETUP message, it MUST close the session with a PROTOCOL_VIOLATION.」と定める。現状は受信 SETUP の Authorization Token の Alias Type を検証していない。

## 現状

- `src/message/authorizationToken.ts` の `assertAuthorizationTokenForSetup` は送信側の `createSetup` からのみ呼ばれる。
- `src/message/setup.ts` の `decodeSetupPayload` / `getSetupAuthorizationTokens` は Alias Type を検査しない。
- `src/session.ts` の SETUP 受信経路は `decodeSetupPayload` を呼ぶだけで `getSetupAuthorizationTokens` を呼ばないため、DELETE / USE_ALIAS が無検証で通る。

## 設計方針

1. SETUP 受信経路で Authorization Token の Alias Type を検査し、DELETE / USE_ALIAS を検出したら `SessionError(PROTOCOL_VIOLATION)` でセッションを閉じる。
2. 検査は `assertAuthorizationTokenForSetup` と同等のロジックを再利用し、送受信で判定が一致するようにする。
3. 受信 SETUP の DELETE / USE_ALIAS を拒否するテストを追加する。

## 完了条件

- 受信 SETUP に DELETE / USE_ALIAS の Authorization Token が含まれる場合、セッションが PROTOCOL_VIOLATION で閉じること。
- REGISTER / USE_VALUE は従来どおり受理されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.2.2 / §10.3.1.4
- `decodeSetupPayload` / `getSetupAuthorizationTokens`
- `assertAuthorizationTokenForSetup` / `AuthorizationTokenAliasType`
- `issues/closed/0331-bug-setup-authorization-token-validation.md`

## 解決方法

- draft-ietf-moq-transport-20 §10.2.2 の MUST は「If **a server** receives Alias Type DELETE (0x0) or USE_ALIAS (0x2) in a SETUP message」と受信主体をサーバーに限定している。moqt-js は client（SERVER_SETUP を受信する側）であり、この MUST の対象ではない。
- 仕様の変更履歴「Disallow DELETE and USE_ALIAS in CLIENT_SETUP (#1277)」も、禁止対象がクライアントが送る SETUP であることを示す。サーバーが SETUP で DELETE / USE_ALIAS を送ることを禁じ、クライアントにセッション終了を義務付ける記述は draft-20 に存在しない。
- closed の `issues/closed/0331-bug-setup-authorization-token-validation.md` が「§10.2.2 はサーバー側の義務であり、クライアントである moqt-js には仕様上の義務はない」と既に結論している。
- 以上より、クライアント側で DELETE / USE_ALIAS を理由にセッションを閉じる仕様上の根拠がないため、本 issue は対応せず closed にする。サーバーが非仕様的な DELETE / USE_ALIAS を送る場合の防御的検査は、必要性が確認された時点で別途起票する。
