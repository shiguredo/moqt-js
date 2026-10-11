# audio-timestamp の skew の判定が、共有が戻った直後の 1 回の観測で落ちる

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-audio-timestamp-skew-judgment
- Polished: {YYYY-MM-DD}

## 目的

`tests/e2e/relay/audio-timestamp.spec.ts` の skew の判定が、実装が守る不変条件ではなく「解除が戻った直後の 1 回の観測」を測っており、同じコミットでも CI の run によって落ちる。CI が赤くなることで、本質的な退行と環境依存の失敗を区別できなくなる。

## 現状

- `expectSkewWithinBudget` (`tests/e2e/relay/audio-timestamp.spec.ts` 736-773 行目) は、記録した観測 (1 秒ごと 25 件) の `skewMs` に予算 (`AV_SKEW_MAX_MS` = 150 ms) を超える値が無いことを見たあと、`expect.poll` で `skewMs` が値になるのを待ち、**その 1 件だけ**を予算と比べる
- 基準の共有を解除すると実装は 30 秒は戻さない (`PLAYOUT_BASE_UNSHARED_HOLD_MS`)。25 秒の観測がまるごと保持の中に入ると、記録した観測の `skewMs` はすべて null になり、判定は解除が戻った直後の 1 件だけで行われる
- 解除が戻った直後は、2 つの表示位置が揃う途中の値であり得る。CI の run 38155230838 (job 114516723936) では、観測値が健全 (音声の基準の遅れ 168.7〜168.8 ms、映像 166.6〜167.1 ms、基準の差 1.7〜2.4 ms、解除の理由は hold) である一方、この 1 件が予算を超えて落ちた。同じコミットの別の run (38155221232) では同じテストが通っている
- 失敗メッセージには観測した `skewMs` の値が入らず、どの値で落ちたかをログから読めない (記録した観測の一覧は null のため `-` と出る)

## 設計方針

- 「ずれが固定した」という症状 (0754) は、続けて予算を超える状態が続くこととして現れる。単発の跳び (表示が一瞬途切れた、解除が戻った直後で位置が揃う途中) と区別し、**続けて予算を超えた時間** で判定する
- 判定の補助として、観測列の「予算を超えた状態が続いた最長時間」を返す純関数を spec 内に置く (観測は `SAMPLE_INTERVAL_MS` ごとの標本である)
- 許す連続超過は `SKEW_OVERFLOW_MAX_MS` (2000 ms、標本 2 件) とする。0754 の症状は数百 ms のずれが固定する (実測で 3370 ms が 23 秒続いた) ため、この値で捕まる
- 共有が戻った後に値が観測できること自体は、これまでどおり判定に残す (値が作られない状態を成功にしない)。待ちは `SKEW_OBSERVE_TIMEOUT_MS` の中で、判断に要る標本数 (`SKEW_MIN_SAMPLES` = 3) が集まるまでとする
- 失敗メッセージに観測した `skewMs` の一覧を入れ、どの値で落ちたかをログから読めるようにする

## 完了条件

- 記録した観測と、共有が戻った後に観測した値の両方について、予算を超えた状態が続いた最長時間が `SKEW_OVERFLOW_MAX_MS` 以下であることを判定する
- 単発の超過 (1 件) では落ちず、続けて超過する (症状が固定する) 場合は落ちる
- 共有が戻った後に `skewMs` が観測できない場合は、これまでどおり失敗する
- 失敗メッセージに観測した `skewMs` の一覧が出る
- `vp check` / `vp exec tsc --noEmit` が通る
- 実リレーの E2E (`vp exec playwright test --project=relay tests/e2e/relay/audio-timestamp.spec.ts`) が通る

## 参照

- `tests/e2e/relay/audio-timestamp.spec.ts` (`expectSkewWithinBudget` / `expectUnsharedRecovers`)
- `tests/e2e/relay/audio-catch-up.spec.ts` (同じ「続けて超えた長さ」で判定する先例)
- draft-ietf-moq-transport-22 (実リレーの挙動の前提)
