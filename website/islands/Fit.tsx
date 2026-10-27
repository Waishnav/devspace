import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

// Lays children out at a fixed design width and scales them down to the
// available width, so an illustration reads like a recording on any screen
// instead of reflowing.
export default function Fit({ width, children }: { width: number; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState<number>();

  useLayoutEffect(() => {
    const measure = () => {
      setScale(Math.min(1, outer.current!.clientWidth / width));
      setHeight(inner.current!.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer.current!);
    observer.observe(inner.current!);
    return () => observer.disconnect();
  }, [width]);

  return (
    <div ref={outer} style={{ height: height === undefined ? undefined : height * scale, overflow: "hidden" }}>
      <div ref={inner} style={{ width, display: "flow-root", transform: `scale(${scale})`, transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
}
