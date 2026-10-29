/**
 * 符号化の出力を送るかの判定の Property-Based Tests
 *
 * 配信を止めた時点で開いている Subgroup を閉じるため、止める前に依頼した出力は送らない
 * (draft-ietf-moq-transport-22 §11.3.2)。依頼と停止が任意の順で起き、出力の到着順も
 * 保証されない状況で、現在の世代の出力を重複 timestamp も含めてすべて送ることを確かめる。
 * 停止前後の世代で同じ値を再利用した出力の識別は対象外である。
 * 個別の境界 (記録が無い出力、異なる世代の上書き) は encodeGeneration.test.ts が固定する。
 */

import { test, assert } from "vite-plus/test";
import * as fc from "fast-check";
import {
  advanceEncodeGeneration,
  recordEncodeGeneration,
  shouldSendEncodedChunk,
  type EncodeState,
} from "./encodeGeneration";

/** 符号化の依頼と送信の停止 */
type Step = { readonly kind: "encode"; readonly timestamp: number } | { readonly kind: "stop" };

test("shouldSendEncodedChunk: 停止を挟んでも、同じ timestamp の複数入力を含め現在の世代の全出力を送る", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          {
            weight: 4,
            arbitrary: fc.record({
              kind: fc.constant("encode" as const),
              timestamp: fc.integer({ min: 0, max: 3 }),
            }),
          },
          { weight: 1, arbitrary: fc.constant({ kind: "stop" as const }) },
        ),
        { minLength: 1, maxLength: 12 },
      ),
      (steps: Step[]) => {
        const state: EncodeState = { generation: 0, records: new Map() };
        /** 依頼した出力 (到着順は保証されないため、記録から選ばれる) */
        const requested: { timestamp: number; generation: number }[] = [];
        for (const step of steps) {
          if (step.kind === "encode") {
            recordEncodeGeneration(state.records, state.generation, step.timestamp);
            requested.push({ timestamp: step.timestamp, generation: state.generation });
          } else {
            advanceEncodeGeneration(state);
          }
        }

        // 出力は依頼の逆順でも届き得る。同じ timestamp でも入力した枚数分の出力が届く。
        // 停止時に記録を捨てるため、停止前だけに存在した timestamp の出力は送らない。
        // 停止後にもある値は現在の世代の出力だけを渡し、識別できない旧世代の同値出力は混ぜない。
        const timestamps = [...new Set(requested.map((item) => item.timestamp))];
        const expected = requested
          .filter((item) => item.generation === state.generation)
          .map((item) => item.timestamp);
        const sent: number[] = [];
        for (const timestamp of timestamps.slice().reverse()) {
          const outputCount = expected.filter((value) => value === timestamp).length;
          for (let index = 0; index < Math.max(1, outputCount); index++) {
            if (shouldSendEncodedChunk(state.records, state.generation, timestamp)) {
              sent.push(timestamp);
            }
          }
          assert.isFalse(shouldSendEncodedChunk(state.records, state.generation, timestamp));
        }
        const compare = (left: number, right: number): number => left - right;
        assert.deepEqual(
          sent.slice().sort(compare),
          expected.slice().sort(compare),
          "送る出力の組が違う",
        );
        // 同じ出力を 2 度送らない (取り出した記録は残らない)
        assert.strictEqual(state.records.size, 0, "取り出していない記録が残っている");
      },
    ),
  );
});
