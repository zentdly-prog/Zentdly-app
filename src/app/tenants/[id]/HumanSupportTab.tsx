"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { getHumanQueueSignature } from "@/lib/actions/conversations";
import { useVisiblePolling } from "@/lib/useVisiblePolling";

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
  // Track the newest queued conversation, not the whole set: this badge renders
  // on every page, so its poll must stay as small as possible.
  const newestId = useRef<string | null>(initialIds[0] ?? null);

  const poll = useCallback(async () => {
    const { count: queueCount, newestId: latest } = await getHumanQueueSignature(tenantId);
    // Ping only when someone new reaches the front of the queue.
    if (latest && latest !== newestId.current) playPling();
    newestId.current = latest;
    setCount(queueCount);
  }, [tenantId]);

  useVisiblePolling(poll, 20_000);

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
