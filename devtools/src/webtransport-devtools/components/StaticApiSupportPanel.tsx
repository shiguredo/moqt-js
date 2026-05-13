import { signal } from "@preact/signals";
import * as store from "../signals";
import type { StaticApiCheck, StaticApiGroup } from "../signals";

// 詳細表示の開閉状態
const expanded = signal(false);

// サマリの 3 状態
type SummaryState = "all" | "partial" | "unsupported";

function computeSummary(groups: StaticApiGroup[]): {
  state: SummaryState;
  unsupportedCount: number;
  totalCount: number;
} {
  // サマリは「現行 API の充足度」を示す指標とし、deprecated 項目は母集団から除外する
  // deprecated の欠落は新ブラウザでは期待される挙動であり、未対応扱いにすると誤解を招く
  const currentItems = groups.flatMap((group) => group.items).filter((item) => !item.deprecated);
  const totalCount = currentItems.length;
  const unsupportedCount = currentItems.filter((item) => !item.supported).length;

  // WebTransport 本体が未対応なら全て未対応と判定する
  const globalGroup = groups.find((group) => group.name === "Global");
  const webTransportItem = globalGroup?.items.find((item) => item.name === "WebTransport");
  if (webTransportItem && !webTransportItem.supported) {
    return { state: "unsupported", unsupportedCount, totalCount };
  }

  if (unsupportedCount === 0) {
    return { state: "all", unsupportedCount, totalCount };
  }
  return { state: "partial", unsupportedCount, totalCount };
}

function summaryBadgeClass(state: SummaryState): string {
  switch (state) {
    case "all":
      return "bg-green-100 text-green-700 border-green-300";
    case "partial":
      return "bg-yellow-100 text-yellow-700 border-yellow-300";
    case "unsupported":
      return "bg-red-100 text-red-700 border-red-300";
  }
}

function summaryBadgeText(
  state: SummaryState,
  unsupportedCount: number,
  totalCount: number,
): string {
  switch (state) {
    case "all":
      return `All Supported (${totalCount} / ${totalCount})`;
    case "partial":
      return `Partially Supported (${totalCount - unsupportedCount} / ${totalCount})`;
    case "unsupported":
      return "WebTransport Not Supported";
  }
}

function itemLabel(item: StaticApiCheck): { text: string; className: string } {
  // deprecated 項目は対応有無に関わらず中立的に表示する
  //   対応: [OK] 琥珀色 (旧実装が残っている / 移行すべき)
  //   未対応: [--] 灰色 (新ブラウザでは期待どおり削除されている)
  if (item.deprecated) {
    return item.supported
      ? { text: "[OK]", className: "text-amber-600 font-semibold" }
      : { text: "[--]", className: "text-slate-400 font-semibold" };
  }
  return item.supported
    ? { text: "[OK]", className: "text-green-600 font-semibold" }
    : { text: "[NG]", className: "text-red-500 font-semibold" };
}

function ApiSupportItem({ item }: { item: StaticApiCheck }) {
  const { text, className } = itemLabel(item);
  const noteClass = item.deprecated ? "text-amber-600" : "text-slate-400";
  return (
    <div class="flex items-baseline gap-2 text-xs font-mono mb-1">
      <span class={`${className} w-10 shrink-0`}>{text}</span>
      <div class="flex-1 min-w-0">
        <div class="text-slate-600 break-all">
          {item.name}
          {item.deprecated && <span class="ml-2 text-amber-600 font-normal">(deprecated)</span>}
          {item.note && <span class={`ml-2 font-normal ${noteClass}`}>({item.note})</span>}
        </div>
        {item.description && (
          <div class="text-slate-400 text-[11px] font-sans mt-0.5">{item.description}</div>
        )}
      </div>
    </div>
  );
}

function ApiSupportGroupBlock({ group }: { group: StaticApiGroup }) {
  return (
    <div class="mb-3">
      <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
        {group.name}
      </div>
      <div class="space-y-0.5 pl-2">
        {group.items.map((item) => (
          <ApiSupportItem key={item.name} item={item} />
        ))}
      </div>
    </div>
  );
}

export function StaticApiSupportPanel() {
  const groups = store.wtStaticApiSupport.value;
  const summary = computeSummary(groups);

  const toggle = () => {
    expanded.value = !expanded.value;
  };

  return (
    <div class="bg-white rounded-xl shadow-sm p-5 mb-6">
      <button
        type="button"
        onClick={toggle}
        class="w-full flex items-center justify-between gap-4 text-left"
      >
        <h2 class="text-lg font-semibold text-slate-700">WebTransport API Support</h2>
        <div class="flex items-center gap-3">
          <span
            class={`px-3 py-1 text-xs font-semibold rounded-full border ${summaryBadgeClass(summary.state)}`}
          >
            {summaryBadgeText(summary.state, summary.unsupportedCount, summary.totalCount)}
          </span>
          <span class="text-slate-400 text-sm">{expanded.value ? "[-]" : "[+]"}</span>
        </div>
      </button>
      {expanded.value && (
        <div class="mt-4 pt-4 border-t border-slate-200">
          <p class="text-xs text-slate-500 mb-3">
            Evaluated on page load against <code class="font-mono">WebTransport.prototype</code> and
            related globals. Independent of connection state.
          </p>
          {groups.map((group) => (
            <ApiSupportGroupBlock key={group.name} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
