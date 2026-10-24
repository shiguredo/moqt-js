/**
 * 音声の再生の累積の計器の差 (audioPlayoutCumulative) の単体テスト
 */

import { test, assert } from "vite-plus/test";
import { subtractAudioPlayoutCumulative } from "./audioPlayoutCumulative";

// 累積は再生の入口の統計として AudioContext の作り直しをまたいで引き継がれる。
// 画面へ出す値は再生を始めた時点 (baseline) からの差にする。入口を作り直した直後は
// baseline が無く、そのときはミリ秒を丸めた累積を表示する (0 から数え直す)。
test("subtractAudioPlayoutCumulative: baseline が無ければミリ秒を丸めた累積を返す", () => {
  const difference = subtractAudioPlayoutCumulative(
    {
      compressedMs: 12.5,
      concealedMs: 3.4,
      concealments: 2,
    },
    null,
  );

  // ミリ秒は画面の表示に合わせて整数へ丸め、回数はそのまま返す
  assert.deepEqual(difference, { compressedMs: 13, concealedMs: 3, concealments: 2 });
});

// AudioContext を作り直すと入口の累積は引き継がれるため、再生を始めた時点の値を引く。
// 引かないと、前の再生で加工した量が次の再生の最初から表示されてしまう。
test("subtractAudioPlayoutCumulative: baseline があれば再生開始時点からの差を返す", () => {
  const difference = subtractAudioPlayoutCumulative(
    {
      compressedMs: 30.5,
      concealedMs: 10.5,
      concealments: 5,
    },
    {
      compressedMs: 20,
      concealedMs: 4,
      concealments: 2,
    },
  );

  assert.deepEqual(difference, { compressedMs: 11, concealedMs: 7, concealments: 3 });
});

// 累積と基準はどちらもミリ秒単位で進む。累積と基準をそれぞれ丸めてから引くと、丸めの
// 境目で 1 ずれる。差を求めてから丸めることで、0.1 ms の差は 0 として表示する。
test("subtractAudioPlayoutCumulative: 差を求めてから丸める", () => {
  const difference = subtractAudioPlayoutCumulative(
    {
      compressedMs: 10.5,
      concealedMs: 10.5,
      concealments: 3,
    },
    {
      compressedMs: 10.4,
      concealedMs: 10.4,
      concealments: 3,
    },
  );

  // それぞれを丸めてから引く実装では 11 - 10 = 1 になる
  assert.deepEqual(difference, { compressedMs: 0, concealedMs: 0, concealments: 0 });
});
