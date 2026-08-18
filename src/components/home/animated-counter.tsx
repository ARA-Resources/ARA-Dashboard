"use client";

import { useEffect, useRef, useState } from "react";
import { useInView, useMotionValue, useSpring } from "framer-motion";
import { cn } from "@/lib/utils";

interface AnimatedCounterProps {
  value: number;
  className?: string;
  duration?: number;
}

export function AnimatedCounter({
  value,
  className,
  duration = 1.2,
}: AnimatedCounterProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const motionValue = useMotionValue(0);
  const spring = useSpring(motionValue, {
    stiffness: 90,
    damping: 24,
  });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!inView) return;
    // Brief delay so the spring feels intentional when scrolled into view
    const timer = window.setTimeout(() => motionValue.set(value), 80);
    return () => window.clearTimeout(timer);
  }, [inView, motionValue, value, duration]);

  useEffect(() => {
    const unsub = spring.on("change", (latest) => {
      setDisplay(Math.round(latest));
    });
    return unsub;
  }, [spring]);

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {display.toLocaleString()}
    </span>
  );
}
