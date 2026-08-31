declare module "*.css";

interface Window {
  openai?: {
    toolOutput?: unknown;
    toolResponseMetadata?: unknown;
  };
}
