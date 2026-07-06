/** MCP tool and parameter names for DevSpace local project scope (not ChatGPT workspace/thread). */

export const OPEN_THREAD_TOOL = "open_thread";

export const THREAD_ID_PARAM = "thread_id";

export const THREAD_ID_DESCRIBE =
  "DevSpace thread identifier returned by open_thread. Identifies an open local project root on the user's machine. Not the ChatGPT conversation thread.";

export const OPEN_THREAD_SHORT_DISCLAIMER =
  "thread_id is DevSpace's local project handle from open_thread, not the ChatGPT conversation thread.";

export const OPEN_THREAD_CALL_HINT =
  "Call open_thread first and pass thread_id on every subsequent file, search, edit, shell, or show-changes tool in that folder.";