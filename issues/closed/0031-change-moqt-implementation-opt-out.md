# MOQT_IMPLEMENTATION の opt-out / override 対応

- Priority: Low
- Created: 2026-03-16
- Completed: 2026-07-31
- Model: manual
- Branch: feature/change-moqt-implementation-opt-out
- Polished: 2026-07-31

## 目的

MOQT_IMPLEMENTATION Setup Option の送信を制御可能にし、draft-ietf-moq-transport-19 §13.8 (Implementation Identification Fingerprinting) のプライバシー緩和策に対応する。

実装名とバージョンを無条件で送信する現状の挙動を維持したまま、`ConnectOptions` で opt-out（送信しない）と override（任意の値を送信）を選択できるようにする。

## 現状

- `src/message/setup.ts` の `createSetup()` は、`MOQT_IMPLEMENTATION` (0x07) を無条件で `parameters` に push している。送信を抑止する分岐は存在しない。
- `src/version.ts` の `MOQT_IMPLEMENTATION_VALUE` は `moqt-js/${version}`（フルバージョン）であり、既定では実装名とフルバージョンがそのまま相手へ送られる。
- `src/session.ts` の `ConnectOptions` には `serverCertificateHashes` / `authorizationToken` / `pendingSubgroup` のみがあり、`MOQT_IMPLEMENTATION` を制御するフィールドは存在しない。
- `src/index.ts` の `connect()` は `ConnectOptions` の `authorizationToken` を `session.initialize()` へ渡しているが、`MOQT_IMPLEMENTATION` に関する pass-through は存在しない。
- `src/message/setup.test.ts` は「MOQT_IMPLEMENTATION は常に追加される」前提で検証しているため、本変更は仕様変更ではなく公開 API の変更として扱う必要がある。

## 設計方針

draft-ietf-moq-transport-19 §10.3.1.5 は "An endpoint SHOULD send a MOQT_IMPLEMENTATION option unless specifically configured not to do so." と定め、§13.8 はプライバシー緩和策として「オプションを完全に省略する」「汎用的な値を送る」「利用者が設定・無効化できるようにする」の 3 つを MAY として提示する。

§13.8 は MAY として 2 項を提示する。第 1 項は「オプションを完全に省略する、または汎用的な値を送る」の 2 択、第 2 項は「利用者がオプションを設定・無効化できるようにする」である。

これを踏まえ、既定は現状どおり送信を維持し、`ConnectOptions` に `moqtImplementation?: string | false` フィールドを追加する。

- 未指定（既定）: `MOQT_IMPLEMENTATION_VALUE`（`moqt-js/${version}`）を送信する。現状の挙動を維持する。
- `false`: `MOQT_IMPLEMENTATION` Option を送信しない（opt-out。§13.8 の "omit the option entirely" に対応）。
- 文字列: その値をそのまま送信する（override。§13.8 の "send a generic value" に対応。例: `moqt-js` のような major のみの値）。空文字列も指定どおりに送信する（値の妥当性検証は行わない）。

伝搬経路は既存の `authorizationToken` と同じ経路を使う。

1. `src/session.ts` の `ConnectOptions` に `moqtImplementation?: string | false` を追加する。
2. `src/index.ts` の `connect()` から `session.initialize()` へ `moqtImplementation` を受け渡す。
3. `src/session.ts` の `initialize()` から `createSetup()` へ `moqtImplementation` を受け渡す。
4. `src/message/setup.ts` の `createSetup()` に `moqtImplementation?: string | false` オプションを追加し、`false` のときは push を抑止、文字列のときはその値をエンコードして push する。

`createSetup()` の既定（オプション未指定）は現状どおり `MOQT_IMPLEMENTATION_VALUE` を送信するため、`createSetup()` を直接呼ぶ既存コードの挙動は変わらない。

## 影響範囲

- `src/session.ts`（`ConnectOptions` へのフィールド追加、`initialize()` の受け渡し）
- `src/index.ts`（`connect()` から `initialize()` への pass-through）
- `src/message/setup.ts`（`createSetup()` の分岐追加）
- `src/message/setup.test.ts`（opt-out / override の検証追加、既存の「常に追加される」前提のテストは既定パスとして維持）

## 完了条件

- `ConnectOptions` に `moqtImplementation?: string | false` が追加され、`connect()` → `initialize()` → `createSetup()` へ伝搬する。
- `moqtImplementation: false` 指定時に送信される SETUP から `MOQT_IMPLEMENTATION` Option が欠落する。
- `moqtImplementation` に文字列を指定したとき、その値が `MOQT_IMPLEMENTATION` Option として送信される。
- 未指定時の既定挙動（`moqt-js/${version}` を送信）が変わらない。
- 上記 3 パターン（既定 / opt-out / override）を `src/message/setup.test.ts` が検証する。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §10.3.1.5 (MOQT IMPLEMENTATION)
- draft-ietf-moq-transport-19 §13.8 (Implementation Identification Fingerprinting)

## reopened にする理由

draft-ietf-moq-transport-19 §13.8 がプライバシー緩和を具体化し、§10.3.1.5 が "unless specifically configured not to do so" と設定による無効化を前提としたため着手可能になった。設計方針は上記「設計方針」セクションのとおり draft-19 に合わせて固定する。

なお `issues/closed/0218-draft-18-update-improve-security-considerations.md` は同一の §13.8 fingerprinting 懸念を扱っているが、コード変更なし（コメント更新のみ）で完了としている。本 issue は公開 API に opt-out / override 機構を追加する点で 0218 とは目的が異なる。

## 解決方法

`ConnectOptions` に `moqtImplementation?: string | false` を追加し、既存の `authorizationToken` と同じ伝搬経路（`connect()` → `initialize()` → `createSetup()`）で SETUP Option (0x07) の送信を制御できるようにした。

- `src/session.ts`: `ConnectOptions` にフィールドを追加し、`initialize()` のオプション経由で `createSetup()` へ受け渡す。
- `src/index.ts`: `connect()` から `initialize()` へ pass-through する。
- `src/message/setup.ts`: `createSetup()` に `moqtImplementation` オプションを追加。`false` で Option を抑止、文字列でその値を送信、未指定で既定値（`moqt-js/${version}`）を送信する。
- `src/message/setup.test.ts`: opt-out / override / 空文字列 / AUTHORIZATION_TOKEN との独立性を単体テストで検証する。
- `src/message/setup.prop.ts`: 既定 / opt-out / override の 3 分岐のラウンドトリップを PBT（`fc.string({ unit: "grapheme" })` で全 Unicode）で検証する。
- `CHANGES.md`: `## develop` に `[ADD]` を追記する。
