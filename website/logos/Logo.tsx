import { logoSvg, type LogoId } from "./index";

// React twin of Logo.astro for islands.
export function Logo({ id, size = 16 }: { id: LogoId; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="ds-logo"
      style={{ width: size, height: size, display: "inline-flex", flex: "none", lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: logoSvg(id) }}
    />
  );
}
