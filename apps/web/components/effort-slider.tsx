"use client";

import { EFFORT_STOPS, type EffortLevel } from "@krubot/shared";
import { useId } from "react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

/**
 * How hard the bots think: the shadcn Slider snapped to four stops. The
 * track's fill and the thumb glide between stops (the slider animates every
 * change that isn't a drag); the labels underneath name each stop.
 */
export function EffortSlider({ value, onChange, disabled = false }: { value: EffortLevel | null; onChange: (value: EffortLevel | null) => void; disabled?: boolean }) {
  const index = Math.max(0, EFFORT_STOPS.findIndex((s) => s.value === value));
  const last = EFFORT_STOPS.length - 1;
  const labelId = useId();
  const stop = EFFORT_STOPS[index]!;

  return (
    <div className="max-w-sm select-none">
      <Slider
        value={index}
        min={0}
        max={last}
        step={1}
        disabled={disabled}
        aria-labelledby={labelId}
        getAriaValueText={(_formatted, v) => EFFORT_STOPS[v]?.label ?? String(v)}
        onValueChange={(next) => {
          const at = Array.isArray(next) ? next[0] : next;
          if (typeof at === "number" && at !== index) onChange(EFFORT_STOPS[at]!.value);
        }}
        className="py-1.5"
      />
      <div className="relative mt-1.5 h-5">
        {EFFORT_STOPS.map((s, i) => (
          <button
            key={s.label}
            type="button"
            disabled={disabled}
            onClick={() => onChange(s.value)}
            className={cn(
              "absolute -translate-x-1/2 text-xs transition-colors duration-300 outline-none hover:text-foreground focus-visible:underline",
              i === 0 ? "translate-x-0" : i === last ? "-translate-x-full" : "",
              i === index ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
            style={{ left: `${(i / last) * 100}%` }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p id={labelId} className="mt-1 text-[12.5px] text-muted-foreground">
        <span className="font-medium text-foreground">{stop.label}.</span> {stop.detail}
      </p>
    </div>
  );
}
