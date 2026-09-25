# moqt-devtools で、接続設定を使っている間も c4m のトークンの Clear を押せる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-c4m-clear-while-in-use
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools は、Publisher か Subscriber が接続設定を使っている間、接続設定の入力を `settingsDisabled` で無効にする。ところが Authorization Token の節にある c4m のトークンの Clear ボタンだけは、この間も押せる。押すと取り込んだトークンと Token Type が書き換わり、画面と Copy URL の内容が、使っている接続設定と食い違う。

## 現状

- `devtools/src/components/ConnectionSettings.tsx` の `ConnectionSettings` では、接続設定の入力とボタンの 26 か所が `disabled={settings.settingsDisabled.value}` を持つ
- c4m から読み込んだトークンを示す行 (`data-testid="authorization-token-c4m"`) の Clear ボタンは `disabled` を持たない
  - `onClick={() => clearImportedC4mToken()}`
  - `clearImportedC4mToken` は `settings.authorizationTokenBase64` を空にし、`settings.authorizationTokenType` を `"0"` にする
- トークンは `buildConnectOptions` で `connect` の前に読まれる。進んでいる接続には影響しないが、画面の Token Type と c4m の表示が、使っている設定と食い違う
- 同じ節の Token Type と Token Value の入力は、`settingsDisabled` の間は無効になり、c4m の解除もできない

## 再現手順

1. MSF URL の c4m を持つ URL (例: `?url=moqt%3A%2F%2Fexample.com%2Fmoqt%23msf%3Aroom-123--catalog%26c4m%3DQUFB`) で devtools を開く
2. Subscriber の Start Subscribing を押す。接続設定の入力が無効になる
3. c4m の行の Clear を押せる。押すと c4m の表示が消え、Token Type が 0 になる

## 設計方針

- Clear ボタンに `disabled={settings.settingsDisabled.value}` を足し、他の入力と同じく使っている間は押せなくする
- 無効のときの見た目を、同じ画面の他のボタンの `disabled:` の class に合わせる
- E2E で確かめる: `tests/e2e/devtools-authorization-token.spec.ts` の c4m を読み込む流れに、`settingsDisabled` を立てた状態で Clear が無効になることを足す。Clear に `data-testid` を足す
  - 実際に購読を始めるには relay が要るため、E2E では `settingsDisabled` を立てる別の方法を決める (例: 到達しない URL へ購読を始め、接続を待っている間に確かめる)。決められない場合は、コンポーネントテストの仕組み (open の `0632-test-component-test-setup.md`) を待つ

## 完了条件

- 接続設定を使っている間は、c4m の Clear を押せない
- 誰も使っていないときは、従来どおり押せて、トークンの取り込みを解除できる
- 上の 2 点をテストで確かめる
- `CHANGES.md` の `## develop` に `[FIX]` で載る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `devtools/src/components/ConnectionSettings.tsx` の `ConnectionSettings` / `clearImportedC4mToken`
- `tests/e2e/devtools-authorization-token.spec.ts` (c4m の取り込みと解除の E2E)
- open の `0705-add-devtools-token-type-candidates.md` (同じ節の Token Type の入力を扱う。c4m の解除の挙動は変えない)
- open の `0632-test-component-test-setup.md` (コンポーネントテストの仕組み)

## 解決方法

{未着手}
