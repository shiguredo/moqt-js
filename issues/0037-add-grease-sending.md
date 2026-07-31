# GREASE Setup Option の opt-in 送信

- Priority: Low
- Created: 2026-03-23
- Completed: 2026-07-31
- Model: manual
- Branch: feature/add-grease-sending
- Polished: 2026-07-31

## 目的

draft-ietf-moq-transport-19 §14 (Grease) に基づき、SETUP メッセージに GREASE Setup Option を opt-in で送信する機能を実装する。

GREASE は未知の値を正しくハンドリングできることを保証するための予約値であり、送信側は SHOULD レベルの推奨（RFC 9170 §3.3 由来）、受信側は MUST で未知値を gracefully に扱う必要がある。moqt-js は受信側（未知 Option の無視）に対応済みだが、送信側で GREASE 値を積極的に送る処理がない。本 issue は SETUP Option への opt-in 送信にスコープを限定する。Object / Track Properties への GREASE 注入は本 issue の対象外とし、後続 issue で扱う。

## 現状

- `src/grease.ts` には `isGreaseValue(value: bigint)` と `generateGreaseValue(n: number)` があるが、値の判定と生成の helper に留まる。ランタイムの送信パスからの参照はゼロであり、送信への配線がない。
- `src/message/setup.ts` の `createSetup()` は `AUTHORIZATION_TOKEN`（任意）/ `MAX_AUTH_TOKEN_CACHE_SIZE`（任意）/ `MOQT_IMPLEMENTATION`（無条件）を追加するのみで、GREASE Setup Option を追加しない。
- `src/session.ts` の `ConnectOptions` と `src/index.ts` の `connect()` に GREASE 送信を制御するフィールドは存在しない。
- 受信側は対応済みである。`decodeSetupPayload()` は未知の Setup Option を保持するが意味付けせず、実質的に無視する。

## 設計方針

draft-ietf-moq-transport-19 §14 の GREASE 値は `0x7f * N + 0x9D`（N は非負整数）のパターンに従う。例: `0x9D`, `0x11C`, `0x19B`, `0x21A`, ...。最大値は `0x3fffffffffffffde`。§15.4 (Setup Options) で `0x7f * N + 0x9D` が "Reserved for greasing" として予約されている。

opt-in の API は既存の `authorizationToken` と同じ伝搬経路を使う。

1. `src/session.ts` の `ConnectOptions` に `grease?: boolean` を追加する。既定は `false`（送信しない）。
2. `src/index.ts` の `connect()` から `session.initialize()` へ `grease` を受け渡す。
3. `src/session.ts` の `initialize()` から `createSetup()` へ `grease` を受け渡す。
4. `src/message/setup.ts` の `createSetup()` に `grease?: boolean` オプションを追加する。`grease: true` のとき、GREASE Setup Option を 1 つ追加する。
   - Option Type は `generateGreaseValue(n)` で生成する。`n` は `Math.random()` で選んだ **偶数** の非負整数とする。`0x7f * N + 0x9D` は N が偶数のとき奇数 Type になる（`0x9D` は奇数、`0x7f * 偶数` は偶数、合計は奇数）。
   - Setup Option のエンコードは `src/message/parameter.ts` の Key-Value-Pairs 規則に従い、**奇数 Type は Length プレフィックス付きバイト列**、偶数 Type は varint 値のみとなる。N を偶数に固定して奇数 Type にすることで、Option Value を任意のバイト列（空バイト列または短いランダムバイト列）として安全に送信できる（§14: "have no semantics and can carry arbitrary values"）。偶数 Type を選ぶと value は有効な varint でなければラウンドトリップが壊れるため、採用しない。
   - `generateGreaseValue()` は `bigint` を返すが、`Parameter.type` は `number` 型である。`Number()` 変換で精度を失わないよう、`n` は結果が `Number.MAX_SAFE_INTEGER`（2^53-1）を超えない範囲で選ぶ。

SETUP はセッション開始時に 1 回だけ送信されるため、確率的な送信制御は行わず、`grease: true` 指定時は常に 1 つの GREASE Option を送信する。

`encodeSetupPayload()` は delta encoding のため Option Type を昇順ソートするが、GREASE Option も他の Option と同様にソート対象となるだけで、エンコードは壊れない。

## 影響範囲

- `src/session.ts`（`ConnectOptions` へのフィールド追加、`initialize()` の受け渡し）
- `src/index.ts`（`connect()` から `initialize()` への pass-through）
- `src/message/setup.ts`（`createSetup()` への GREASE Option 追加）
- `src/message/setup.test.ts`（opt-in 送信の検証追加）

## 完了条件

- `ConnectOptions` に `grease?: boolean` が追加され、`connect()` → `initialize()` → `createSetup()` へ伝搬する。
- `grease: true` 指定時に送信される SETUP に、`isGreaseValue()` が `true` を返す Option Type の Setup Option が 1 つ含まれる。
- `grease` 未指定または `false` のとき、SETUP に GREASE Option が含まれない（既定挙動は不変）。
- GREASE Option を含む SETUP が `encodeSetupPayload()` / `decodeSetupPayload()` でラウンドトリップする。
- 上記を `src/message/setup.test.ts` が検証する。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §14 (Grease)
- draft-ietf-moq-transport-19 §15.4 (Setup Options)
- RFC 9170 §3.3 (GREASE 送信の SHOULD 推奨)

## reopened にする理由

draft-ietf-moq-transport-19 §14 でも GREASE 予約は存続しており、実装対象として有効なため。`generateGreaseValue()` / `isGreaseValue()` は `src/grease.ts` に存在し、未配線なのは送信パスのみである。

着手スコープは SETUP Option への opt-in GREASE 送信に限定する。Object / Track Properties への注入は本 issue の必須とせず、後続 issue に分ける。

## 解決方法

`ConnectOptions` に `grease?: boolean` を追加し、既存の `authorizationToken` と同じ伝搬経路（`connect()` → `initialize()` → `createSetup()`）で GREASE Setup Option の opt-in 送信を実装した。

- `src/session.ts`: `ConnectOptions` にフィールドを追加し、`initialize()` のオプション経由で `createSetup()` へ受け渡す。
- `src/index.ts`: `connect()` から `initialize()` へ pass-through する。
- `src/message/setup.ts`: `createSetup()` に `grease` オプションを追加。`true` のとき GREASE Setup Option を 1 つ追加する。Option Type は `generateGreaseSetupOptionType()` が生成する。N を偶数に固定して奇数 Type（Length プレフィックス付きバイト列）にし、`Number.MAX_SAFE_INTEGER` 内に収める。value は空バイト列。
- `src/message/setup.test.ts`: grease 未指定 / false / true の各ケース、`isGreaseValue()` による予約値検証、奇数 Type・範囲の不変条件（100 回サンプリング）、roundtrip（20 回サンプリング）を検証する。
- `CHANGES.md`: `## develop` に `[ADD]` を追記する。
