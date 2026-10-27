import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HostContext, ToolResultCard } from "./card-types.js";
import {
  parseReviewFiles,
  ReviewDiffFile,
  ReviewFileDiff,
  reviewFileKey,
  type ReviewThemeType,
} from "./review-diff.js";

interface PayloadRendererOptions {
  card: ToolResultCard;
  hostContext?: HostContext;
  errorMessage?: string | null;
  visibleFileCount?: number;
}

interface MountedPayload {
  update(options: PayloadRendererOptions): void;
  unmount(): void;
}

export function mountReviewPayload(
  container: HTMLElement,
  options: PayloadRendererOptions,
): MountedPayload {
  const root = createRoot(container);
  root.render(<ReviewPayload {...options} />);

  return {
    update(nextOptions) {
      root.render(<ReviewPayload {...nextOptions} />);
    },
    unmount() {
      root.unmount();
    },
  };
}

function ReviewPayload({
  card,
  hostContext,
  errorMessage = null,
  visibleFileCount,
}: PayloadRendererOptions) {
  const patch = card.payload?.patch;
  const themeType: ReviewThemeType = hostContext?.theme === "light" ? "light" : "dark";
  const files = useMemo(() => parseReviewFiles(patch), [patch]);

  const visibleFiles = typeof visibleFileCount === "number"
    ? files.slice(0, visibleFileCount)
    : files;

  const [openFiles, setOpenFiles] = useState(() => new Set<string>());

  if (errorMessage) return <StatusLine message={errorMessage} tone="error" />;

  if (!patch) return <StatusLine message="Diff payload is not available." />;

  if (files.length === 0) return <StatusLine message="No diff hunks to review." />;

  if (files.length === 1) {
    return (
      <div className="review-single-file">
        <ReviewFileDiff fileDiff={files[0]!} themeType={themeType} />
      </div>
    );
  }

  return (
    <div className="review-diff pretty-scrollbar">
      <div className="review-diff-files">
        {visibleFiles.map((fileDiff, index) => {
          const key = reviewFileKey(fileDiff, index);

          return (
            <ReviewDiffFile
              key={key}
              fileDiff={fileDiff}
              index={index}
              files={card.files ?? []}
              themeType={themeType}
              open={openFiles.has(key)}
              onToggle={() => {
                const next = new Set(openFiles);

                if (next.has(key)) {
                  next.delete(key);
                } else {
                  next.add(key);
                }

                setOpenFiles(next);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return <div className={`status ${tone}`}>{message}</div>;
}
