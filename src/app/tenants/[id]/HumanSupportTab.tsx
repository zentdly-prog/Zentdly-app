"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getHumanQueue } from "@/lib/actions/conversations";

function playPling() {
  try {
    const ctx = new AudioContext();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      osc.start(t);
      osc.stop(t + 0.7);
    });
  } catch {
    // AudioContext blocked until the user interacts with the page — ignore
  }
}

export default function HumanSupportTab({
  tenantId,
  initialCount,
  initialIds,
}: {
  tenantId: string;
  initialCount: number;
  initialIds: string[];
}) {
  const [count, setCount] = useState(initialCount);
  const seen = useRef(new Set(initialIds));

  useEffect(() => {
    let active = true;

    const poll = async () => {
      const queue = await getHumanQueue(tenantId);
      if (!active) return;
      const currentIds = queue.map((c) => c.id);
      const hasNew = currentIds.some((id) => !seen.current.has(id));
      if (hasNew) playPling();
      // Keep `seen` in sync with the live queue so resolved+re-requested conversations ping again.
      seen.current = new Set(currentIds);
      setCount(queue.length);
    };

    const interval = setInterval(poll, 12_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [tenantId]);

  const active = count > 0;

  return (
    <Link
      href={`/tenants/${tenantId}/support`}
      className={`relative flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 border-transparent transition-colors ${
        active ? "text-red-600 hover:border-red-300" : "text-gray-600 hover:text-gray-900 hover:border-gray-300"
      }`}
    >
      {active && <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />}
      Atención humana
      {active && (
        <span className="ml-0.5 bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
          {count}
        </span>
      )}
    </Link>
  );
}
