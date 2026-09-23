/**
 * MediaPublisher Property-Based Tests
 *
 * Audio Config の送出判断 (resolveAudioConfigToSend) は「直前に送った値」と
 * 「送り直し要求」を持ち回る小さな状態機械である。任意の chunk 列に対して
 * 成立すべき不変条件を検証する。個々の分岐の境界値は
 * createMediaPublisher.test.ts の単体テストが固定する。
 *
 * draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config) /
 * draft-ietf-moq-transport-21 §7.5 (Publisher Interactions)
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import { resolveAudioConfigToSend } from "./createMediaPublisher";

/**
 * 2 つの description が同じバイト列かを判定する
 *
 * 検証側の比較は文字列化した経路で行い、実装の判定 (長さ比較 + 添字ループ) と
 * 同じ書き方にならないようにする。
 */
function isSameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return Array.from(left).join(",") === Array.from(right).join(",");
}

/**
 * 1 chunk 分の入力
 *
 * description は encoder の metadata が持つ Audio Config であり、undefined は
 * description を持たない chunk (opus) を表す。resendRequested は Forward State が
 * 0 から 1 になった時点で立つ送り直し要求である。
 */
interface AudioConfigStep {
  description: Uint8Array | undefined;
  resendRequested: boolean;
}

const nonEmptyDescriptionArbitrary: fc.Arbitrary<Uint8Array> = fc.oneof(
  // 実際の AAC の AudioSpecificConfig 相当 (2 バイト) を混ぜつつ、
  // 長さが食い違う分岐も探索できるようランダムな長さを厚めに生成する
  { arbitrary: fc.constant(new Uint8Array([0x11, 0x90])), weight: 1 },
  { arbitrary: fc.uint8Array({ minLength: 1, maxLength: 8 }), weight: 3 },
);

// 空の description も境界として生成する (値なしとして扱われる)
const descriptionArbitrary: fc.Arbitrary<Uint8Array> = fc.oneof(
  nonEmptyDescriptionArbitrary,
  fc.constant(new Uint8Array(0)),
);

const stepArbitrary: fc.Arbitrary<AudioConfigStep> = fc.record({
  // opus のように description を持たない chunk も生成する
  description: fc.option(descriptionArbitrary, { nil: undefined }),
  resendRequested: fc.boolean(),
});

/** chunk 列を 1 度駆動したときの、各 chunk の入力と結果 */
interface AudioConfigStepResolution {
  description: Uint8Array | undefined;
  config: Uint8Array | undefined;
  next: Uint8Array | null;
  previous: Uint8Array | null;
  resendRequested: boolean;
}

/**
 * chunk 列を順に駆動する
 *
 * 送り直し要求は Forward State の 0 から 1 の変化で立つため、前の chunk で
 * 残った要求を次の chunk へ引き継ぐ (実装と同じく、載せた時点で解消する)。
 */
function driveAudioConfigResolution(steps: AudioConfigStep[]): AudioConfigStepResolution[] {
  const results: AudioConfigStepResolution[] = [];
  let current: Uint8Array | null = null;
  let pendingRequest = false;

  for (const step of steps) {
    const resendRequested = step.resendRequested || pendingRequest;
    const resolution = resolveAudioConfigToSend(current, step.description, resendRequested);
    results.push({
      description: step.description,
      config: resolution.config,
      next: resolution.next,
      previous: current,
      resendRequested,
    });
    current = resolution.next;
    pendingRequest = resolution.resendNext;
  }
  return results;
}

test("resolveAudioConfigToSend: 送出する config は保持値と一致し、保持値は直前の値か今回の description に限る", () => {
  // 実装が保持していない値を送らないこと、独自の値を保持しないことの検証
  fc.assert(
    fc.property(fc.array(stepArbitrary, { maxLength: 30 }), (steps) => {
      for (const result of driveAudioConfigResolution(steps)) {
        if (result.config !== undefined) {
          assert.isNotNull(result.next);
          assert.isTrue(isSameBytes(result.config, result.next));
        }
        if (result.next !== null) {
          const matchesCurrent =
            result.description !== undefined && isSameBytes(result.next, result.description);
          assert.isTrue(matchesCurrent || isSameBytes(result.next, result.previous));
        }
      }
    }),
  );
});

test("resolveAudioConfigToSend: 初出と変更の description は必ず載る", () => {
  // AAC の AudioSpecificConfig は取りこぼすと復号できない。直前の保持値と異なる
  // description が現れた chunk では、要求の有無にかかわらず必ず載る
  // (空の description は設定として意味を持たないため対象外)
  fc.assert(
    fc.property(fc.array(stepArbitrary, { maxLength: 30 }), (steps) => {
      for (const result of driveAudioConfigResolution(steps)) {
        const description = result.description;
        const mustCarry =
          description !== undefined &&
          description.length > 0 &&
          !isSameBytes(result.previous, description);
        if (mustCarry) {
          assert.isTrue(isSameBytes(result.config ?? null, description));
        }
      }
    }),
  );
});

test("resolveAudioConfigToSend: 送り直し要求が立っている Object では保持値がある限り必ず載る", () => {
  // 購読者の出現 (Forward State の 0 から 1) を知ったのに載せないと、
  // 後着の購読者が AAC を復号できない。要求が立っている限り必ず載ることを検証する
  fc.assert(
    fc.property(fc.array(stepArbitrary, { maxLength: 30 }), (steps) => {
      for (const result of driveAudioConfigResolution(steps)) {
        if (result.resendRequested && result.previous !== null) {
          assert.isDefined(result.config);
        }
      }
    }),
  );
});

test("resolveAudioConfigToSend: 要求が無い限り同じ値の config を連続で載せない", () => {
  // 完了条件「同じ Audio Config を毎 Object 送らない」の検証。送り直し要求が
  // 立たない列では、直前の送出と同一の config が再び載ってはならない
  fc.assert(
    fc.property(
      fc.array(fc.record({ description: fc.option(descriptionArbitrary, { nil: undefined }) }), {
        maxLength: 30,
      }),
      (steps) => {
        const results = driveAudioConfigResolution(
          steps.map((step) => ({ description: step.description, resendRequested: false })),
        );
        let lastEmitted: Uint8Array | null = null;

        for (const result of results) {
          if (result.config !== undefined) {
            if (lastEmitted !== null) {
              assert.isFalse(isSameBytes(result.config, lastEmitted));
            }
            lastEmitted = result.config;
          }
        }
      },
    ),
  );
});

test("resolveAudioConfigToSend: 送り直しは 1 Object に限り、保持値は複製して持つ", () => {
  // 送り直し要求には 1 度だけ応え、その次の Object では載らないこと、
  // 渡した配列の書き換えが保持値に影響しないことを任意の description で検証する
  fc.assert(
    fc.property(nonEmptyDescriptionArbitrary, (description) => {
      // 1 度目の送出で保持し、同じ値をもう一度渡しても載らない
      const first = resolveAudioConfigToSend(null, description, false);
      assert.isTrue(isSameBytes(first.next, description));
      const again = resolveAudioConfigToSend(first.next, new Uint8Array(description), false);
      assert.isUndefined(again.config);

      // 要求には 1 度だけ応える
      const resent = resolveAudioConfigToSend(again.next, undefined, true);
      assert.isTrue(isSameBytes(resent.config ?? null, description));
      assert.isFalse(resent.resendNext);
      assert.isUndefined(resolveAudioConfigToSend(resent.next, undefined, false).config);

      // 保持値は複製するため、渡した配列の書き換えに影響されない
      const original = new Uint8Array(description);
      const mutable = new Uint8Array(description);
      const held = resolveAudioConfigToSend(null, mutable, false);
      mutable.fill(0xff);
      assert.isTrue(isSameBytes(held.next, original));
    }),
  );
});
