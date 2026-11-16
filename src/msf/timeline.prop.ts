import { assert } from "vite-plus/test";
import { fc, test } from "@fast-check/vitest";
import {
  decodeEventTimeline,
  decodeMediaTimeline,
  encodeMediaTimeline,
  filterMediaTimelineByRanges,
} from "./timeline";

const entry = fc.tuple(
  fc.nat(),
  fc.tuple(fc.bigInt({ min: 0n, max: 1000n }), fc.bigInt({ min: 0n, max: 1000n })),
  fc.nat(),
);

test.prop([fc.array(entry, { minLength: 1, maxLength: 16 })])(
  "空の range 配列は種類ごとに制限なしとして扱う",
  (entries) => {
    // 公開 API の契約。空配列の有無で同じエントリの適否が変わってはならない。
    for (const ranges of [
      { wallclock: [] },
      { mediaTime: [] },
      { location: [] },
      { wallclock: [], mediaTime: [], location: [] },
    ]) {
      assert.deepEqual(filterMediaTimelineByRanges(entries, ranges), entries);
    }
  },
);

test.prop([fc.constantFrom(Number.NaN, Infinity, -Infinity), fc.boolean()])(
  "Media Timeline の符号化は非有限 timestamp を拒否する",
  (timestamp, wallclock) => {
    // JSON.stringify による null への変換を許すと、自分の decoder が拒否する wire を生成する。
    assert.throws(
      () => encodeMediaTimeline([[wallclock ? 0 : timestamp, [0n, 0n], wallclock ? timestamp : 0]]),
      /invalid media timeline entry/,
    );
  },
);

test.prop([fc.integer({ min: 309, max: 350 }), fc.constantFrom("media", "wallclock", "T", "M")])(
  "Timeline の復号は JSON 数値が Infinity へ桁あふれする timestamp を拒否する",
  (exponent, field) => {
    // JSON の数値としては構文上有効でも、この実装の有限な時刻として扱えない値は拒否する。
    const literal = `1e${exponent}`;
    const json =
      field === "media"
        ? `[[${literal},[0,0],0]]`
        : field === "wallclock"
          ? `[[0,[0,0],${literal}]]`
          : `[{"${field}":${literal},"data":null}]`;
    const bytes = new TextEncoder().encode(json);
    assert.throws(
      () =>
        field === "media" || field === "wallclock"
          ? decodeMediaTimeline(bytes)
          : decodeEventTimeline(bytes),
      /invalid .* timeline entry/,
    );
  },
);
