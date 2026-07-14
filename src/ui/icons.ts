import {
  ChevronDown,
  FileDiff,
  FileMinus,
  FilePenLine,
  FilePlus,
  FileText,
  Files,
  FolderOpen,
  FolderTree,
  LoaderCircle,
  Search,
  SquareTerminal,
  Terminal,
  createElement,
  type IconNode,
} from "lucide";

export const toolIcons = {
  chevronDown: ChevronDown,
  deleteFile: FileMinus,
  diff: FileDiff,
  editFile: FilePenLine,
  files: Files,
  folderOpen: FolderOpen,
  folderTree: FolderTree,
  loading: LoaderCircle,
  readFile: FileText,
  search: Search,
  terminal: Terminal,
  terminalSquare: SquareTerminal,
  writeFile: FilePlus,
} as const satisfies Record<string, IconNode>;

export type ToolIcon = IconNode;

export function renderIcon(icon: ToolIcon, className = "icon-svg"): SVGElement {
  return createElement(icon, {
    class: className,
    "aria-hidden": "true",
  });
}
