# moqt-devtools で、接続設定を使っている間も c4m のトークンの Clear を押せる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-c4m-clear-while-in-use
- Polished: 2026-11-14

## 目的

moqt-devtools は、Publisher か Subscriber が接続設定を使っている間、接続設定の入力を `settingsDisabled` で無効にする。ところが Authorization Token の節にある c4m のトークンの Clear ボタンだけは、この間も押せる。押すと取り込んだトークンと Token Type が書き換わり、画面の表示が、使っている接続設定と食い違う。

## 現状

- `devtools/src/components/ConnectionSettings.tsx` の `ConnectionSettings` では、接続設定の入力とボタンの 29 か所 (2026-11-14 時点) が `disabled={settings.settingsDisabled.value}` を持つ
- c4m から読み込んだトークンを示す行 (`data-testid="authorization-token-c4m"`) の Clear ボタンは `disabled` を持たない
  - `data-testid="authorization-token-c4m-clear"` と `onClick={() => settings.clearImportedC4mToken()}` を持つ
  - `clearImportedC4mToken` は `settings.authorizationTokenBase64` を空にし、`settings.authorizationTokenType` を `"0"` にする。MOQT URI と URI Fragment からも c4m を取り除く (`devtools/src/signals/connectionSettings.ts`)
- トークンは接続直前に `resolveConnectAuthorizationToken` で決まり、`buildConnectOptions` に渡される。`connect` はその `authorizationToken` を使う (`devtools/src/signals/connectionSettings.ts` / `devtools/src/hooks/useSubscriber.ts` の `resolveSubscriberConnectSettings` / `src/connect.ts`)
  - 進んでいる接続には影響しないが、画面の Token Type と c4m の表示が、使っている設定と食い違う
- 同じ節の Token Type と Token Value の入力は、`settingsDisabled` の間は無効になり、この 2 つの入力からは c4m を解除できない

## 再現手順

1. MSF URL の c4m を持つ URL (例: `?url=moqt%3A%2F%2Fexample.com%2Fmoqt%23msf%3Aroom-123--catalog%26c4m%3DQUFB`) で devtools を開く
2. Subscriber の Start Subscribing を押す。接続を待っている間、接続設定の入力が無効になる
3. c4m の行の Clear を押せる。押すと c4m の表示が消え、Token Type が 0 になる

## 設計方針

- Clear ボタンに `disabled={settings.settingsDisabled.value}` を足し、他の入力と同じく使っている間は押せなくする
- 無効のときの見た目は、同じ画面の他のボタン (`moqt-uri-candidates-open` など) の `disabled:` の class に合わせ、`disabled:text-slate-400` と `disabled:cursor-not-allowed` を足す。Clear は背景を持たないテキストのボタンなので `disabled:bg-slate-100` は付けない。ホバーの色は `enabled:hover:text-slate-700` にして、無効時は変わらないようにする
- E2E で確かめる。`tests/e2e/devtools-authorization-token.spec.ts` には、有効時の Clear のテスト (`c4m の Clear で取り込みが解除され MOQT URI からも c4m が消える`) と `data-testid="authorization-token-c4m-clear"` が既にあるため、これらは変えない
  - `settingsDisabled` のとき: Clear が無効になることを、次の手順で確かめる
    - c4m 付きの URL を開き、`settingsDisabled` を立てるため、応答が返らない接続先 (`moqt://192.0.2.1/`。TEST-NET-1 で QUIC の handshake が返らない) へ Subscriber の Start Subscribing を押す
    - 接続の確立を待っている間に、Clear が無効で、Token Type の入力も無効であることを確かめる
    - 接続がすぐ失敗して `settingsDisabled` が戻る接続先 (`example.com` など) は使わない
  - `settingsDisabled` は `startSubscribing` が `connect` を呼ぶ前に立つ (`devtools/src/hooks/useSubscriber.ts`)。購読の確立を待つ間は立ったままである
  - コンポーネントテスト基盤 (open の `0632-test-component-test-setup.md`) はまだ導入されていないため、E2E で確かめる
- `settingsDisabled` ではないときの Clear の動作 (c4m の表示が消え、Token Type が 0 になり、MOQT URI から c4m が消える) は、既存の E2E で固定されている

## 完了条件

- 接続設定を使っている間は、c4m の Clear を押せない
- 誰も使っていないときは、従来どおり押せて、トークンの取り込みを解除できる
- 上の 2 点をテストで確かめる。無効のときは新しく足す E2E で、有効のときは既存の E2E で確かめる
- `CHANGES.md` は `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」に従い変更しない (ルールの見直しは open の `0861-update-changelog-draft-rule.md` で扱う)
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `devtools/src/components/ConnectionSettings.tsx` の `ConnectionSettings` / Clear ボタン
- `devtools/src/signals/connectionSettings.ts` の `settingsDisabled` / `clearImportedC4mToken` / `buildConnectOptions` / `resolveConnectAuthorizationToken`
- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` (`settingsDisabled` を立てる) / `resolveSubscriberConnectSettings` (接続設定を決める)
- `devtools/src/hooks/usePublisher.ts` の `startPublishing` (`settingsDisabled` を立てる)
- `src/connect.ts` の `connect` (接続オプションの `authorizationToken` を使う)
- `tests/e2e/devtools-authorization-token.spec.ts` (c4m の取り込みと解除、および Clear の E2E)
- open の `0705-add-devtools-token-type-candidates.md` (同じ節の Token Type の入力を扱う。c4m の解除の挙動は変えない)
- open の `0632-test-component-test-setup.md` (コンポーネントテストの仕組み)
- open の `0861-update-changelog-draft-rule.md` (CHANGES.md の扱いの見直し)
- `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」

## 解決方法

{未着手}
